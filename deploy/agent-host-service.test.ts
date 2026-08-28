import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function render(service: string) {
  return service
    .replaceAll("@@WORKING_DIRECTORY@@", repoRoot)
    .replaceAll("@@BUN@@", process.execPath)
    .replaceAll("@@GATEWAY_UID@@", "12345")
    .replaceAll("@@HOST_UID@@", "12346");
}

describe("detached Agent Host deployment foundation", () => {
  test("renders hardened generation service and root-owned socket templates", async () => {
    const serviceTemplate = await Bun.file(resolve(repoRoot, "opensession-agent-host@.service")).text();
    const socket = await Bun.file(resolve(repoRoot, "opensession-agent-host@.socket")).text();
    const service = render(serviceTemplate);
    expect(service).not.toContain("@@");
    expect(service).toContain("User=opensession-agent-host");
    expect(service).toContain("StateDirectory=opensession/agent-host/%i");
    expect(service).toContain("StateDirectoryMode=0700");
    expect(service).toContain("ExecStartPre=");
    expect(service).toContain("--doctor --generation %i --expected-gateway-uid 12345 --expected-host-uid 12346");
    expect(service).toContain("RuntimeMaxSec=24h");
    expect(service).toContain("TimeoutStopSec=20s");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("IPAddressDeny=any");
    expect(service).not.toContain("EnvironmentFile=");
    expect(service).not.toContain("agent-host-supervision-signing-key");
    expect(socket).toContain("ListenStream=/run/opensession/agent-host-%i.sock");
    expect(socket).toContain("FileDescriptorName=agent-host");
    expect(socket).toContain("SocketUser=root");
    expect(socket).toContain("SocketGroup=opensession-gateway");
    expect(socket).toContain("SocketMode=0660");
  });

  test("systemd-analyze accepts rendered templates when available", async () => {
    if (Bun.spawnSync(["sh", "-c", "command -v systemd-analyze"], { stdout: "ignore" }).exitCode !== 0) return;
    const directory = await mkdtemp(join(tmpdir(), "agent-host-units-"));
    try {
      const service = render(await Bun.file(resolve(repoRoot, "opensession-agent-host@.service")).text());
      const socket = await Bun.file(resolve(repoRoot, "opensession-agent-host@.socket")).text();
      const servicePath = join(directory, "opensession-agent-host@.service");
      const socketPath = join(directory, "opensession-agent-host@.socket");
      await Promise.all([writeFile(servicePath, service), writeFile(socketPath, socket)]);
      const result = Bun.spawnSync(["systemd-analyze", "verify", servicePath, socketPath], { stderr: "pipe", stdout: "pipe" });
      expect(new TextDecoder().decode(result.stderr)).not.toContain("Unknown key");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("root installer creates separate identities without activating topology", async () => {
    const installer = await Bun.file(resolve(import.meta.dir, "install-agent-host-topology.sh")).text();
    const deploy = await Bun.file(resolve(import.meta.dir, "deploy.sh")).text();
    for (const identity of ["opensession-gateway", "opensession-session-kernel", "opensession-agent-host", "opensession-executor"])
      expect(installer).toContain(identity);
    expect(installer).toContain("distinct UIDs");
    expect(installer).toContain("/var/lib/opensession/agent-host");
    expect(installer).not.toMatch(/systemctl\s+enable/);
    expect(installer).not.toMatch(/systemctl\s+start/);
    expect(deploy).toContain("install-agent-host-topology.sh");
  });

  test("has no owned production socket or runner-host fallback", async () => {
    const runtime = await Bun.file(resolve(repoRoot, "packages/core/opensession-server/src/agent-host/runtime.ts")).text();
    expect(runtime).toContain("inheritedFd: fd");
    expect(runtime).not.toContain("socketPath:");
    expect(runtime).not.toContain("runner-host");
    expect(runtime).not.toContain("gateway-local");
  });

  test("keeps all key material in systemd credentials", async () => {
    const service = await Bun.file(resolve(repoRoot, "opensession-agent-host@.service")).text();
    const signing = await Bun.file(resolve(import.meta.dir, "systemd/agent-host-unactivated/opensession-session-kernel.service.d/agent-host-signing-credential.conf")).text();
    expect(service).toContain("LoadCredential=agent-host-ledger-keyring:");
    expect(service).toContain("LoadCredential=agent-host-supervision-keyring:");
    expect(signing).toContain("LoadCredential=agent-host-supervision-signing-key:");
    expect(signing).toContain("FUTURE ACTIVATION TEMPLATE");
  });
});
