/**
 * Engine-neutral run policy shared by Pi and effective-config inspection.
 * It owns trusted run kinds, unattended classification, pool wait budgets,
 * tool stripping, and instance-local instruction loading.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const INTERACTIVE_KINDS = new Set([
  "prompt",
  "goal",
  "create",
  "linear",
  "slack",
  "workflow",
]);

const UNATTENDED_KINDS = new Set([
  "automation",
  "plain",
  "action",
  "security-scan",
]);

export function isUnattendedKind(base: string): boolean {
  return UNATTENDED_KINDS.has(base) || base.startsWith("github-");
}

/**
 * Trusted GitHub-automation code runs that may carry a repo-scoped App
 * credential (githubCodeRunEnv). These are the GitHub agent's own `github-*`
 * code workflows — review, autofix, simplify, mention, followup, adversarial,
 * public-review — every one launched as `github-<kind>` by the agent's runner.
 * A predicate rather than an inline prefix test so the one credential-gating
 * rule has a name and a test. Event-driven automations (slack/linear/plain/
 * webhook intake) are deliberately absent and stay credential-free.
 */
export function githubAutomationKind(kind?: string): boolean {
  return baseJournalKind(kind).startsWith("github-");
}

/** Which GitHub credential a run's child environment earns:
 *  - "code": the repo-scoped App credential (githubCodeRunEnv) — for the
 *    GitHub agent's `github-*` code workflows and for review/handoff fix
 *    rounds (`fixRound`), which push fixes and reply in review threads;
 *  - "user": the run owner's own token (githubRunEnv), for ordinary
 *    interactive turns;
 *  - "none": nothing — every unattended, event-driven automation
 *    (slack/linear/plain/webhook intake) that is not one of the two above.
 *  The App code credential is reserved for code-mode runs; it never reaches an
 *  event automation, which carries neither a `github-*` kind nor a fix-round
 *  mark. */
export function githubRunCredentialKind(input: {
  mode?: string;
  kind?: string;
  fixRound?: boolean;
  /** interactiveGithub: a non-unattended run of an INTERACTIVE_KIND. */
  interactive: boolean;
}): "code" | "user" | "none" {
  if (
    input.mode === "code" &&
    (githubAutomationKind(input.kind) || Boolean(input.fixRound))
  )
    return "code";
  return input.interactive ? "user" : "none";
}

const POOL_WAIT_UNATTENDED_MS = Number(
  process.env.OPENSESSION_POOL_WAIT_MS || 10 * 60_000,
);

export function poolWaitMsFor(kind?: string): number {
  return isUnattendedKind(baseJournalKind(kind)) ? POOL_WAIT_UNATTENDED_MS : 0;
}

export function baseJournalKind(kind?: string): string {
  return (kind || "").replace(/(-(resume|rerun|fallback))+$/, "");
}

export function runGateReason(opts: {
  journal?: { kind?: string };
  allowSmoke?: boolean;
}): string | null {
  if (opts.allowSmoke) return null;
  const base = baseJournalKind(opts.journal?.kind);
  if (INTERACTIVE_KINDS.has(base) || isUnattendedKind(base)) return null;
  return base
    ? `The Pi engine is not available to "${base}" runs. Interactive sessions and automations only.`
    : "The Pi engine requires an explicit run kind (journal.kind).";
}

export interface RunToolPolicy {
  unattended: boolean;
  disables: Record<string, false>;
  noteGroups: Array<{ message: string; tools: string[] }>;
}

export const LOCAL_WORKSPACE_TOOL_IDS = [
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "apply_patch",
  "grep",
  "glob",
] as const;

/** Claude-style MCP name to the bridge's registered tool id. */
export function deniedToolIds(
  name: string,
  opts?: { broad?: boolean },
): string[] {
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return [name];
  if (opts?.broad) {
    return [`${match[1]}_${match[2]}`, `*_${match[2]}`, match[2]];
  }
  return [`${match[1]}_${match[2]}`];
}

/** Strip denied and approval-gated tools before the model sees them. */
export function runToolPolicy(opts: {
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  journalKind?: string;
  disableLocalWorkspaceTools?: boolean;
}): RunToolPolicy {
  const disables: Record<string, false> = { question: false };
  if (opts.disableLocalWorkspaceTools) {
    for (const name of LOCAL_WORKSPACE_TOOL_IDS) disables[name] = false;
  }
  const denied = opts.deniedTools || {};
  const unattended =
    Object.keys(denied).length > 0 ||
    isUnattendedKind(baseJournalKind(opts.journalKind));
  const merged: Record<string, string> = { ...denied };
  const broadNames = new Set(Object.keys(opts.confirmTools || {}));
  for (const [name, label] of Object.entries(opts.confirmTools || {})) {
    if (name in merged) continue;
    merged[name] = unattended
      ? `"${label}" requires per-call human approval, and this run is unattended. ` +
        "This tool is not available; post the exact action you want taken, including " +
        "the tool name and full parameters, in your internal note for human review."
      : `"${label}" requires per-call human approval, which this engine cannot collect. ` +
        "This tool is not available; state the exact action, tool name, and full " +
        "parameters in your reply and ask the human to execute it.";
  }
  const byMessage = new Map<string, string[]>();
  for (const [name, message] of Object.entries(merged)) {
    for (const id of deniedToolIds(name, { broad: broadNames.has(name) })) {
      disables[id] = false;
    }
    const group = byMessage.get(message);
    if (group) group.push(name);
    else byMessage.set(message, [name]);
  }
  return {
    unattended,
    disables,
    noteGroups: [...byMessage.entries()].map(([message, tools]) => ({
      message,
      tools,
    })),
  };
}

/** Read untracked instance-local instructions at the workspace root. */
export function readLocalInstructions(
  dir: string | undefined,
): string | undefined {
  if (!dir) return undefined;
  const parts: string[] = [];
  for (const name of ["AGENTS.local.md", "CLAUDE.local.md"]) {
    const path = join(dir, name);
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").trim();
      if (text) parts.push(text);
    } catch {}
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
