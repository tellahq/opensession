/** `opensession sandbox …` — one-command local provider setup. */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectSandboxProvider,
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  updateSandboxConnection,
} from "../../packages/core/opensession-server/src/server/sandbox/connections";
import { qualifySandboxConnection } from "../../packages/core/opensession-server/src/server/sandbox/qualification";
import { upsertCaddyIngress } from "../../packages/core/opensession-server/src/server/sandbox/caddy-ingress";
import { savePublicIngress } from "../../packages/core/opensession-server/src/server/ingress-settings";
import { configuredServer } from "../../packages/core/opensession-server/src/server/config";
import { stateDir } from "../../packages/core/opensession-server/src/server/paths";
import { writeJsonAtomic } from "../../packages/core/opensession-server/src/server/shared/atomic-write";
import { REPO_ROOT } from "./paths";
import { localAutomationToken } from "./local-auth";
import { dim, fail, heading, info, ok, run, runInherit, warn } from "./ui";

function sandboxConfigPath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

function updateSandboxConfig(patch: Record<string, unknown>): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(sandboxConfigPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      raw = parsed;
  } catch {}
  writeJsonAtomic(sandboxConfigPath(), { ...raw, ...patch });
  chmodSync(sandboxConfigPath(), 0o600);
}

async function qualifyRemoteThroughServer(
  provider: "daytona" | "box" | "modal",
): Promise<number> {
  const token = localAutomationToken();
  if (!token) {
    fail(
      "no local Open Session web session is available",
      "open the app once, then rerun this command; remote qualification must run inside the server process",
    );
    return 1;
  }
  const base = `http://127.0.0.1:${configuredServer().port}`;
  const headers = {
    Cookie: `opensession_auth=${token}`,
    "Content-Type": "application/json",
  };
  let start: Response;
  try {
    start = await fetch(`${base}/api/sandbox/connections/${provider}/test`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(
      "Open Session is not reachable on its local port",
      "start the service before testing Daytona, Box or Modal",
    );
    return 1;
  }
  const started = (await start.json().catch(() => ({}))) as {
    error?: string;
    operation?: { id?: string };
  };
  if (!start.ok || !started.operation?.id) {
    fail(
      "remote qualification could not start",
      started.error || `HTTP ${start.status}`,
    );
    return 1;
  }
  const operationId = started.operation.id;
  for (let attempt = 0; attempt < 600; attempt++) {
    await Bun.sleep(1_000);
    const status = await fetch(`${base}/api/sandbox/status`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    const body = status?.ok
      ? ((await status.json().catch(() => ({}))) as {
          operations?: Array<{
            id: string;
            status: "running" | "succeeded" | "failed";
            stage?: string;
            failureSummary?: string;
          }>;
        })
      : undefined;
    const operation = body?.operations?.find(
      (candidate) => candidate.id === operationId,
    );
    if (!operation || operation.status === "running") continue;
    if (operation.status === "succeeded") {
      ok(`${provider} is Ready`);
      return 0;
    }
    fail(
      `${provider} needs attention`,
      operation.failureSummary || "qualification failed",
    );
    return 1;
  }
  fail(
    `${provider} qualification timed out`,
    "check Workspace → Sandboxes for the operation state",
  );
  return 1;
}

async function requireCommand(name: string, hint: string): Promise<boolean> {
  if (Bun.which(name)) {
    ok(name);
    return true;
  }
  fail(`${name} is missing`, hint);
  return false;
}

async function installPersistentHostFirewall(): Promise<boolean> {
  const setup = `${REPO_ROOT}/deploy/sandbox/setup-host.sh`;
  const unitPath = "/etc/systemd/system/opensession-sandbox-host.service";
  if (
    !(await requireCommand(
      "sudo",
      "install sudo and grant this operator host setup access",
    ))
  ) {
    return false;
  }
  const scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-unit-"));
  const staged = join(scratch, "opensession-sandbox-host.service");
  const unit = `[Unit]\nDescription=Open Session sandbox host firewall\nAfter=docker.service network-online.target\nWants=docker.service network-online.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/bash ${setup}\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n`;
  try {
    await Bun.write(staged, unit);
    for (const argv of [
      ["sudo", "-n", "install", "-m", "0644", staged, unitPath],
      ["sudo", "-n", "systemctl", "daemon-reload"],
      [
        "sudo",
        "-n",
        "systemctl",
        "enable",
        "--now",
        "opensession-sandbox-host.service",
      ],
    ]) {
      const result = await run(argv);
      if (result.code !== 0) {
        fail(
          "could not install the persistent sandbox firewall",
          result.stderr || argv.join(" "),
        );
        return false;
      }
    }
    ok("persistent metadata-service firewall", unitPath);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function releaseVersion(): Promise<string> {
  const pkg = await Bun.file(`${REPO_ROOT}/package.json`).json();
  return String(pkg.version || "latest");
}

async function installDockerImage(): Promise<string | null> {
  const version = await releaseVersion();
  const releaseImage = `ghcr.io/tellahq/opensession-runner:${version}`;
  heading("Runner image");
  const pull = await run(["docker", "pull", releaseImage]);
  if (pull.code === 0) {
    if (!Bun.which("cosign")) {
      fail(
        "cosign is required to verify the published runner image",
        "install cosign, then rerun this command",
      );
      return null;
    }
    const verify = await run([
      "cosign",
      "verify",
      "--certificate-identity-regexp",
      "^https://github.com/tellahq/opensession/.github/workflows/sandbox-release.yml@refs/.*$",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      releaseImage,
    ]);
    if (verify.code !== 0) {
      fail("runner image signature verification failed");
      return null;
    }
    ok("verified release image", releaseImage);
    return releaseImage;
  }

  warn(
    "no matching published image; building this checkout for the local architecture",
  );
  const code = await runInherit(
    ["bash", `${REPO_ROOT}/deploy/sandbox/build.sh`],
    REPO_ROOT,
  );
  if (code !== 0) {
    fail("runner image build failed");
    return null;
  }
  return "opensession-runner:latest";
}

async function enableDocker(): Promise<number> {
  heading("Docker sandbox");
  if (
    !(await requireCommand(
      "docker",
      "install Docker Engine, then rerun this command",
    ))
  )
    return 1;
  const daemon = await run([
    "docker",
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (daemon.code !== 0) {
    fail(
      "Docker daemon is unavailable",
      "start Docker and allow this user to access its socket",
    );
    return 1;
  }
  ok("Docker daemon", daemon.stdout);
  const image = await installDockerImage();
  if (!image) return 1;
  if (!(await installPersistentHostFirewall())) return 1;

  updateSandboxConfig({
    workspace: "volume",
    transport: "ws",
    snapshots: {
      enabled: true,
      onIdle: true,
      maxPerSession: 2,
      quickSyncOnRestore: true,
    },
  });
  connectSandboxProvider("docker", {
    settings: { image, cpu: 4, memoryMb: 8192 },
  });
  heading("Qualification");
  try {
    await qualifySandboxConnection("docker");
  } catch (error) {
    fail(
      "Docker needs attention",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
  ok("Docker is Ready", "select it in Workspace → Sandboxes");
  return 0;
}

async function installCaddyIngress(
  originValue: string | undefined,
): Promise<number> {
  let origin: string;
  try {
    const parsed = new URL(originValue || "");
    if (parsed.protocol !== "https:") throw new Error("HTTPS is required");
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    origin = parsed.toString().replace(/\/$/, "");
  } catch {
    fail(
      "usage: opensession sandbox ingress install https://ingress.example.com",
    );
    return 1;
  }
  if (
    !(await requireCommand(
      "caddy",
      "install Caddy, or copy the generated Settings snippet manually",
    ))
  ) {
    return 1;
  }
  if (
    !(await requireCommand(
      "sudo",
      "grant this operator Caddy configuration access",
    ))
  )
    return 1;

  const caddyfile = process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
  let main = "";
  try {
    main = readFileSync(caddyfile, "utf-8");
  } catch {
    fail(`could not read ${caddyfile}`);
    return 1;
  }
  const scratch = mkdtempSync(join(tmpdir(), "opensession-caddy-ingress-"));
  const staged = join(scratch, "Caddyfile");
  const backup = `${caddyfile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const sudo = ["sudo", "-n"];
  const rollback = async () => {
    await run([...sudo, "cp", "-p", backup, caddyfile]);
    await run([...sudo, "systemctl", "reload", "caddy"]);
  };
  try {
    try {
      await Bun.write(staged, upsertCaddyIngress(main, origin));
    } catch (error) {
      fail(
        "Open Session could not safely update this Caddyfile",
        String(error),
      );
      return 1;
    }
    if ((await run([...sudo, "cp", "-p", caddyfile, backup])).code !== 0) {
      fail("could not back up the Caddyfile");
      return 1;
    }
    if (
      (await run([...sudo, "install", "-m", "0644", staged, caddyfile]))
        .code !== 0
    ) {
      await rollback();
      fail(
        "could not install the managed Caddy routes; the prior Caddyfile was restored",
      );
      return 1;
    }
    const validate = await run([
      ...sudo,
      "caddy",
      "validate",
      "--config",
      caddyfile,
      "--adapter",
      "caddyfile",
    ]);
    if (validate.code !== 0) {
      await rollback();
      fail(
        "Caddy rejected the generated configuration; the prior Caddyfile was restored",
        validate.stderr,
      );
      return 1;
    }
    const reload = await run([...sudo, "systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      fail(
        "Caddy reload failed; the prior Caddyfile was restored",
        reload.stderr,
      );
      return 1;
    }
    let healthy = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`${origin}/ingress-health`, {
          signal: AbortSignal.timeout(5_000),
        });
        healthy = response.ok && (await response.text()).trim() === "ok";
      } catch {}
      if (healthy) break;
      await Bun.sleep(1_000);
    }
    if (!healthy) {
      await rollback();
      fail("the public ingress check failed; the prior Caddyfile was restored");
      return 1;
    }
    await savePublicIngress({ publicBaseUrl: origin, exposure: "custom" });
    ok("sandbox ingress is Ready", origin);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function sandbox(args: string[]): Promise<number> {
  const action = args[0];
  const provider = args[1];
  if (action === "ingress" && provider === "install") {
    return installCaddyIngress(args[2]);
  }
  if (!isWorkspaceSandboxProvider(provider)) {
    fail("usage: opensession sandbox enable docker");
    info(
      dim(
        "Also available: opensession sandbox test|disable docker|daytona|box|modal",
      ),
    );
    info(dim("Provider accounts are connected in Workspace → Sandboxes."));
    return 1;
  }
  if (action === "enable") {
    if (provider !== "docker") {
      fail(`${provider} credentials are connected in Workspace → Sandboxes`);
      return 1;
    }
    return enableDocker();
  }
  if (action === "disable") {
    if (!getSandboxConnection(provider)) {
      fail(`${provider} is not connected`);
      return 1;
    }
    updateSandboxConnection(provider, { enabled: false });
    ok(
      `${provider} is disabled`,
      "configuration and existing sandboxes were preserved",
    );
    return 0;
  }
  if (action === "test") {
    if (!getSandboxConnection(provider)) {
      fail(`${provider} is not connected`);
      return 1;
    }
    heading(`${provider} qualification`);
    if (provider === "daytona" || provider === "box" || provider === "modal") {
      return qualifyRemoteThroughServer(provider);
    }
    try {
      await qualifySandboxConnection(provider);
      ok(`${provider} is Ready`);
      return 0;
    } catch (error) {
      fail(
        `${provider} needs attention`,
        error instanceof Error ? error.message : String(error),
      );
      return 1;
    }
  }
  fail("usage: opensession sandbox enable docker");
  info(
    dim(
      "Also available: opensession sandbox test|disable docker|daytona|box|modal",
    ),
  );
  return 1;
}
