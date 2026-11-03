/**
 * Engine-neutral run policy shared by Pi and effective-config inspection.
 * It owns trusted run kinds, unattended classification, pool wait budgets,
 * tool stripping, and instance-local instruction loading.
 */
import { readFile } from "node:fs/promises";
import { join } from "path";
import { STRIPE_APPROVAL_GATED_TOOLS } from "./stripe-approvals";

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

/** Drop the tools Stripe's two-party approvals hold from a deny or confirm
 *  catalog. With approvals enforced, Stripe (not the tool list) is what
 *  stops a refund or cancellation, so every run keeps them. */
export function withoutStripeApprovalTools(
  tools: Record<string, string> | undefined,
  stripeApprovals: boolean | undefined,
): Record<string, string> | undefined {
  if (!tools || !stripeApprovals) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) => !STRIPE_APPROVAL_GATED_TOOLS.has(name),
    ),
  );
}

/** Strip denied and approval-gated tools before the model sees them. */
export function runToolPolicy(opts: {
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  journalKind?: string;
  disableLocalWorkspaceTools?: boolean;
  /** `integrations.stripe.approvalsEnforced` (stripeApprovalsEnforced). */
  stripeApprovals?: boolean;
}): RunToolPolicy {
  const disables: Record<string, false> = { question: false };
  if (opts.disableLocalWorkspaceTools) {
    for (const name of LOCAL_WORKSPACE_TOOL_IDS) disables[name] = false;
  }
  const unattended =
    Object.keys(opts.deniedTools || {}).length > 0 ||
    isUnattendedKind(baseJournalKind(opts.journalKind));
  const denied =
    withoutStripeApprovalTools(opts.deniedTools, opts.stripeApprovals) || {};
  const confirm =
    withoutStripeApprovalTools(opts.confirmTools, opts.stripeApprovals) || {};
  const merged: Record<string, string> = { ...denied };
  const broadNames = new Set(Object.keys(confirm));
  for (const [name, label] of Object.entries(confirm)) {
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
export async function readLocalInstructions(
  dir: string | undefined,
): Promise<string | undefined> {
  if (!dir) return undefined;
  const parts: string[] = [];
  for (const name of ["AGENTS.local.md", "CLAUDE.local.md"]) {
    const path = join(dir, name);
    try {
      const text = (await readFile(path, "utf8")).trim();
      if (text) parts.push(text);
    } catch {}
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
