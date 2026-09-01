/** Provider qualification orchestration. */

import { audit } from "../audit";
import {
  setSandboxConnectionQualification,
  type WorkspaceSandboxProvider,
} from "./connections";
import { sandboxConfig } from "./config";
import { verifyPublicSandboxIngress } from "./ingress-check";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function command(
  argv: string[],
  timeoutMs = 120_000,
): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        child.kill();
        resolve(124);
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function qualifyDocker(): Promise<void> {
  if (!Bun.which("docker")) {
    throw Object.assign(new Error("Docker is not installed"), {
      code: "DOCKER_NOT_INSTALLED",
    });
  }
  const info = await command(
    ["docker", "info", "--format", "{{.ServerVersion}}"],
    30_000,
  );
  if (info.exitCode !== 0) {
    throw Object.assign(new Error("Docker daemon is unavailable"), {
      code: "DOCKER_DAEMON_UNAVAILABLE",
    });
  }
  const image = sandboxConfig().image || "opensession-runner:latest";
  const inspect = await command(["docker", "image", "inspect", image], 30_000);
  if (inspect.exitCode !== 0) {
    throw Object.assign(
      new Error("Open Session sandbox image is not installed"),
      {
        code: "DOCKER_IMAGE_MISSING",
      },
    );
  }
  const suffix = crypto.randomUUID().slice(0, 12);
  const source = `opensession-qualification-${suffix}`;
  const snapshot = `opensession-qualification:${suffix}`;
  try {
    const run = await command([
      "docker",
      "run",
      "-d",
      "--name",
      source,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      image,
      "sh",
      "-lc",
      "sleep 300",
    ]);
    if (run.exitCode !== 0)
      throw new Error("Docker qualification container failed to start");
    const probe = await command([
      "docker",
      "exec",
      source,
      "sh",
      "-lc",
      "uname -s && printf opensession-qualified > /tmp/opensession-qualification",
    ]);
    if (probe.exitCode !== 0)
      throw new Error("Docker qualification command failed");
    const commit = await command(
      ["docker", "commit", source, snapshot],
      180_000,
    );
    if (commit.exitCode !== 0)
      throw new Error("Docker qualification snapshot failed");
    const restored = await command([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      snapshot,
      "sh",
      "-lc",
      'test "$(cat /tmp/opensession-qualification)" = opensession-qualified',
    ]);
    if (restored.exitCode !== 0) {
      throw new Error(
        "Docker qualification snapshot did not restore filesystem state",
      );
    }
  } finally {
    await command(["docker", "rm", "-f", source], 30_000).catch(
      () => undefined,
    );
    await command(["docker", "image", "rm", "-f", snapshot], 30_000).catch(
      () => undefined,
    );
  }
}

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
    DOCKER_NOT_INSTALLED: "Install Docker, then run the enable command again.",
    DOCKER_DAEMON_UNAVAILABLE:
      "Start Docker and make it available to the Open Session service user.",
    DOCKER_IMAGE_MISSING:
      "Build or install the Open Session sandbox image, then test again.",
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
    if (provider === "daytona" || provider === "box" || provider === "modal") {
      // Prove ingress before allocating paid provider compute.
      update({ stage: "Checking public ingress", progress: 10 });
      await verifyPublicSandboxIngress();
    }
    update({ stage: "Checking provider", progress: 20 });
    if (provider === "docker") await qualifyDocker();
    else if (provider === "daytona") {
      const { qualifyDaytonaConnection } = await import("./adapters/daytona");
      await qualifyDaytonaConnection();
    } else if (provider === "box") {
      const { qualifyBoxConnection } = await import("./adapters/box");
      await qualifyBoxConnection((stage, progress) =>
        update({ stage, progress }),
      );
    } else {
      const { qualifyModalConnection } = await import("./adapters/modal");
      await qualifyModalConnection();
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
