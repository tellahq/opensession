import type { RunActivity } from "@tellahq/opensession-protocol/events";
import { toolFamily } from "@tellahq/opensession-protocol/tool-presentation";
import { elapsedSince } from "./time";

const STILL_WORKING_MS = 10_000;

export interface BusyActivityStatus {
  label: string;
  /** A quieter second fact about the same phase ("attempt 2 of 3"). */
  detail?: string;
  elapsed: string | null;
}

/** What one running tool is doing, by family rather than by tool name: the
 * tool's own row says which command or file, this only names the phase. */
function toolLabel(toolName: string | undefined, count: number): string {
  if (count > 1) return `Running ${count} tools`;
  switch (toolFamily(toolName || "")) {
    case "run":
      return "Running a command";
    case "file":
      return "Reading a file";
    case "edit":
      return "Editing a file";
    case "find":
      return "Searching";
    case "web":
      return "Reading the web";
    case "agent":
      return "Waiting for an agent";
    case "skill":
      return "Loading a skill";
    case "checklist":
      return "Updating the plan";
    default:
      return "Calling a tool";
  }
}

function preparingLabel(toolName: string | undefined): string {
  switch (toolFamily(toolName || "")) {
    case "run":
      return "Writing a command";
    case "edit":
      return "Writing an edit";
    default:
      return "Preparing a tool call";
  }
}

/**
 * The phase the engine reported, in words. Null for a phase this client does
 * not know (a newer server), so the caller falls back to the neutral wording.
 */
function activityLabel(
  activity: RunActivity,
  nowMs: number,
): Pick<BusyActivityStatus, "label" | "detail"> | null {
  switch (activity.kind) {
    case "waiting":
      return { label: "Waiting for the model" };
    case "thinking":
      return { label: "Thinking" };
    case "writing":
      return { label: "Writing" };
    case "preparing":
      return { label: preparingLabel(activity.toolName) };
    case "tool":
      return { label: toolLabel(activity.toolName, activity.count) };
    case "compacting":
      return { label: "Compacting the conversation" };
    case "retrying": {
      const seconds = Math.ceil((activity.retryAt - nowMs) / 1000);
      return {
        label: seconds > 0 ? `Retrying in ${seconds}s` : "Retrying",
        detail: `attempt ${activity.attempt} of ${activity.maxAttempts}`,
      };
    }
    default:
      return null;
  }
}

/** Phases that must stay visible even under streamed text: neither is the
 * model talking, and both explain a pause the words above cannot. */
export function activityInterruptsStream(
  activity: RunActivity | null | undefined,
): boolean {
  return activity?.kind === "compacting" || activity?.kind === "retrying";
}

/**
 * Status copy for a live run. With a phase from the engine it names that
 * phase; without one it only claims what the client knows, that the request
 * remains active, so the wording never invents a model or tool phase.
 */
export function busyActivityStatus(
  elapsedMs: number,
  activity?: RunActivity | null,
  nowMs: number = Date.now(),
): BusyActivityStatus {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const slow = safeElapsedMs >= STILL_WORKING_MS;
  const elapsed = slow ? elapsedSince(0, safeElapsedMs) : null;
  const named = activity ? activityLabel(activity, nowMs) : null;
  if (named) return { ...named, elapsed };
  return { label: slow ? "Still working" : "Working", elapsed };
}
