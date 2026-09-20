/** Source-file naming shared with the synchronous offline scanner. Keep this
 * leaf free of catalog/runtime imports; importing it does not load the gateway.
 */
import { statePath } from "./paths";
export type AgentSessionKind = "slack" | "linear";

/** Bookkeeping files that share the Slack store directory. */
export const AGENT_SESSION_STORE_SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
  "processed-events.json",
  "github-deliveries.json",
  "event-inbox.json",
]);

/** The agent-owned store directories, resolved when asked so a test that
 * repoints HOME or the state root sees its own. Only targeted single-file
 * reads and the offline scanner open them. */
export function agentSessionSourceDirectory(kind: AgentSessionKind): string {
  return statePath(kind === "slack" ? ".slack-sessions" : ".linear-sessions");
}

/** The catalog key of a source file: its basename without `.json`. */
export function agentSessionSourceKey(file: string): string {
  return file.endsWith(".json") ? file.slice(0, -".json".length) : file;
}
