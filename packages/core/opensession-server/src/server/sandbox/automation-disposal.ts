import { audit } from "../audit";
import { updateSessionFile } from "../session-cache";
import type { SandboxProvider } from "./provider";

/**
 * Destroy one disposable automation Executor and leave only the provider
 * selection on the session. A later prompt can then create a fresh Executor,
 * while a stale cleanup cannot erase a newer run's sandbox mapping.
 */
export async function disposeAutomationSandbox(args: {
  provider: Pick<SandboxProvider, "id" | "destroy">;
  sandboxId: string;
  sessionId: string;
}): Promise<void> {
  const { provider, sandboxId, sessionId } = args;
  try {
    await provider.destroy(sandboxId, { strict: true });
    await updateSessionFile(sessionId, (data) => {
      if (data.sandbox?.sandboxId !== sandboxId) return data;
      return {
        ...data,
        sandbox: {
          provider: data.sandbox.provider,
          lifecycle: "sleeping",
        },
      };
    });
    audit({
      kind: "sandbox_automation_disposed",
      session_id: sessionId,
      provider: provider.id,
      sandbox_id: sandboxId,
    });
  } catch (error) {
    await updateSessionFile(sessionId, (data) => {
      if (data.sandbox?.sandboxId !== sandboxId) return data;
      return {
        ...data,
        sandbox: {
          ...data.sandbox,
          lifecycle: "needs_attention",
          lastLifecycleError: String(
            error instanceof Error ? error.message : error,
          ).slice(0, 200),
        },
      };
    }).catch(() => {});
    audit({
      kind: "sandbox_automation_dispose_failed",
      session_id: sessionId,
      provider: provider.id,
      sandbox_id: sandboxId,
      error: String(error instanceof Error ? error.message : error),
    });
    throw error;
  }
}
