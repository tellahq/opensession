/** `opensession sandbox …` — Sandbox provider maintenance from the shell. */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  updateSandboxConnection,
  type WorkspaceSandboxProvider,
} from "../../packages/core/opensession-server/src/server/sandbox/connections";
import { upsertCaddyIngress } from "../../packages/core/opensession-server/src/server/sandbox/caddy-ingress";
import { savePublicIngress } from "../../packages/core/opensession-server/src/server/ingress-settings";
import { configuredServer } from "../../packages/core/opensession-server/src/server/config";
import { localAutomationToken } from "./local-auth";
import { dim, fail, heading, info, ok, run } from "./ui";

async function qualifyRemoteThroughServer(
  provider: WorkspaceSandboxProvider,
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
      "start the service before testing Daytona or Box",
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
    fail("usage: opensession sandbox test|disable daytona|box");
    info(dim("Provider accounts are connected in Workspace → Sandboxes."));
    return 1;
  }
  if (action === "enable") {
    fail(`${provider} credentials are connected in Workspace → Sandboxes`);
    return 1;
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
    return qualifyRemoteThroughServer(provider);
  }
  fail("usage: opensession sandbox test|disable daytona|box");
  return 1;
}
