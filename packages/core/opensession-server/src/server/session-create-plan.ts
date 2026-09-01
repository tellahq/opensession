import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import type { SessionKernelStoreApi } from "./session-kernel/store";
import type { CreationAttachmentSource } from "./uploads";

export interface DurableCreatePlan {
  version: 1;
  sessionId: string;
  identity: string;
  createdAt: string;
  branch?: string;
  workspaceId?: string;
  /** Durable source identities only. Attachment bodies remain in the upload spool. */
  attachments?: CreationAttachmentSource[];
  /** Serializable ResolvedCreate decisions; attachment bodies and functions stay external. */
  resolved?: Record<string, unknown>;
}

function planDir(): string {
  return join(OPENSESSION_SESSIONS_DIR, "create-plans");
}

function planPath(sessionId: string): string {
  return join(planDir(), `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export function readCreatePlanForRecovery(
  sessionId: string,
): DurableCreatePlan | undefined {
  const path = planPath(sessionId);
  if (!existsSync(path)) return undefined;
  const plan = JSON.parse(readFileSync(path, "utf8")) as DurableCreatePlan;
  if (plan.version !== 1 || plan.sessionId !== sessionId)
    throw new Error(`Invalid durable create plan for ${sessionId}`);
  return plan;
}

export function readCreatePlan(
  sessionId: string,
  identity: string,
): DurableCreatePlan | undefined {
  const plan = readCreatePlanForRecovery(sessionId);
  if (!plan) return undefined;
  if (plan.identity !== identity) {
    throw new Error(
      `Create request id for ${sessionId} was reused with another payload`,
    );
  }
  return plan;
}

export function clearCreatePlan(sessionId: string): void {
  rmSync(planPath(sessionId), { force: true });
}

export function pruneCreatePlans(
  store: SessionKernelStoreApi,
  now = Date.now(),
  terminalRetentionMs = 24 * 60 * 60_000,
): number {
  const dir = planDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const plan = JSON.parse(readFileSync(path, "utf8")) as DurableCreatePlan;
      const age = now - Date.parse(plan.createdAt);
      const receipt = store.command(plan.sessionId, plan.identity);
      const terminal =
        receipt?.status === "completed" ||
        receipt?.status === "indeterminate" ||
        (receipt?.status === "failed" && !receipt.retryable);
      if (terminal && age >= terminalRetentionMs) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // Invalid plans remain forensic evidence; recovery reports them explicitly.
    }
  }
  return removed;
}

export function createPlanWorkspaceId(sessionId: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
  return `ws-${digest.slice(0, 32)}`;
}

const UNDEFINED_VALUE = { __opensessionCreateUndefined: true } as const;

function snapshotValue(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_VALUE;
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        snapshotValue(item),
      ]),
    );
  return value;
}

function restoreValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__opensessionCreateUndefined === true
  )
    return undefined;
  if (Array.isArray(value)) return value.map(restoreValue);
  if (value && typeof value === "object") {
    const restored: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      restored[key] = restoreValue(item);
    return restored;
  }
  return value;
}

/** Preserve present and absent decisions without copying attachments/functions. */
export function snapshotResolvedCreate(
  value: Record<string, unknown>,
): Record<string, unknown> {
  // gitEnv carries short-lived bearer tokens. A durable plan keeps only the
  // non-secret gitPrincipal and resolves its current token during recovery.
  const { gitEnv: _ephemeralGitEnv, ...durable } = value;
  return snapshotValue(durable) as Record<string, unknown>;
}

export function snapshotOpeningCreate(value: object): Record<string, unknown> {
  const {
    images: _images,
    materializeWorktree: _materializeWorktree,
    autoNameWorkspace,
    ...durable
  } = value as Record<string, unknown>;
  const renameTarget =
    autoNameWorkspace &&
    typeof autoNameWorkspace === "object" &&
    !Array.isArray(autoNameWorkspace) &&
    typeof (autoNameWorkspace as Record<string, unknown>).id === "string"
      ? {
          id: (autoNameWorkspace as Record<string, unknown>).id,
          name: (autoNameWorkspace as Record<string, unknown>).name,
        }
      : autoNameWorkspace;
  return snapshotResolvedCreate({
    ...durable,
    autoNameWorkspace: renameTarget,
  });
}

export function restoreResolvedCreate<T>(
  value: Record<string, unknown>,
): Partial<T> {
  return restoreValue(value) as Partial<T>;
}
