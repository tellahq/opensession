/** Provider qualification orchestration. */

import { audit } from "../audit";
import {
  setSandboxConnectionQualification,
  type WorkspaceSandboxProvider,
} from "./connections";
import { verifyPublicSandboxIngress } from "./ingress-check";

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code)) return code;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("unauthor") ||
    message.includes("token") ||
    message.includes("api key")
  ) {
    return "CREDENTIAL_REJECTED";
  }
  if (message.includes("quota") || message.includes("limit"))
    return "PROVIDER_QUOTA";
  if (message.includes("snapshot") || message.includes("image"))
    return "SNAPSHOT_FAILED";
  return "QUALIFICATION_FAILED";
}

function failureSummary(code: string): string {
  const summaries: Record<string, string> = {
    INGRESS_URL_MISSING: "Add a public callback URL, then test again.",
    INGRESS_URL_INSECURE: "Use an HTTPS/WSS callback URL, then test again.",
    INGRESS_HEALTH_FAILED:
      "Caddy is not routing sandbox ingress health to port 3860.",
    INGRESS_WEBSOCKET_FAILED:
      "Caddy did not complete an authenticated sandbox WebSocket upgrade.",
    INGRESS_TIMEOUT: "The public sandbox ingress did not respond in time.",
    CREDENTIAL_REJECTED:
      "The provider rejected the workspace credentials. Replace them and retry.",
    PROVIDER_QUOTA:
      "The provider account has insufficient quota for a disposable test sandbox.",
    SNAPSHOT_FAILED:
      "The provider could not restore a distinct qualification snapshot.",
  };
  return (
    summaries[code] ||
    "Qualification failed. Review provider and ingress diagnostics, then retry."
  );
}

function safeFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&]_token=)[^&\s)]+/gi, "$1[redacted]")
    .replace(/\bbox_[A-Za-z0-9_-]+\b/g, "Box")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export async function qualifySandboxConnection(
  provider: WorkspaceSandboxProvider,
  update: (patch: {
    stage: string;
    progress?: number;
    detail?: string;
  }) => void = () => undefined,
): Promise<void> {
  setSandboxConnectionQualification(provider, { status: "checking" });
  try {
    // Prove ingress before allocating paid provider compute.
    update({ stage: "Checking public ingress", progress: 10 });
    await verifyPublicSandboxIngress();
    update({ stage: "Checking provider", progress: 20 });
    if (provider === "daytona") {
      const { qualifyDaytonaConnection } = await import("./adapters/daytona");
      await qualifyDaytonaConnection();
    } else {
      const { qualifyBoxConnection } = await import("./adapters/box");
      await qualifyBoxConnection((stage, progress) =>
        update({ stage, progress }),
      );
    }
    setSandboxConnectionQualification(provider, {
      status: "ready",
      checkedAt: new Date().toISOString(),
    });
    audit({ kind: "sandbox_connection_qualified", provider });
  } catch (error) {
    const code = failureCode(error);
    const genericSummary = failureSummary(code);
    const detail = safeFailureDetail(error);
    const summary =
      code === "QUALIFICATION_FAILED" && detail
        ? `Qualification failed: ${detail}`
        : genericSummary;
    setSandboxConnectionQualification(provider, {
      status: "failed",
      checkedAt: new Date().toISOString(),
      failureCode: code,
      failureSummary: summary,
    });
    console.error(
      `[sandbox:qualification] ${provider} failed (${code}): ${detail || "unknown error"}`,
    );
    audit({
      kind: "sandbox_connection_qualification_failed",
      provider,
      failure_code: code,
    });
    throw Object.assign(new Error(summary), { code });
  }
}
