import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bootstrapRemoteSandbox,
  bootstrapSignature,
  remoteRunnerHostCommand,
  REMOTE_REPO,
  REMOTE_RUNNER_BINARY,
  type RemoteDriver,
} from "./bootstrap";

const originalConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
const scratch: string[] = [];

afterEach(() => {
  if (originalConfig === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = originalConfig;
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("remote runner bootstrap", () => {
  test("keeps the guest checkout independent from the host release path", () => {
    expect(REMOTE_REPO).toBe("/home/ubuntu/projects/opensession");
  });

  test("repairs the workload identity client after a provider resume", async () => {
    const commands: string[] = [];
    const driver: RemoteDriver = {
      async exec(command) {
        commands.push(command);
        if (command.startsWith("cat ")) {
          return {
            exitCode: 0,
            stdout: `${bootstrapSignature()}\n`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };

    await bootstrapRemoteSandbox(driver, "test");

    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("/deploy/sandbox/opensession");
    expect(commands[1]).toContain(
      "test -x /home/ubuntu/.local/bin/opensession",
    );
    expect(commands[1]).toContain("bun build --compile");
    expect(commands[1]).toContain(REMOTE_RUNNER_BINARY);
  });

  test("prefers the compiled runner host with a source fallback", () => {
    const command = remoteRunnerHostCommand("/runs/rh-test/spec.json");
    expect(command).toContain(
      `${REMOTE_RUNNER_BINARY} runner-host /runs/rh-test/spec.json`,
    );
    expect(command).toContain("bun run");
    expect(command).toContain(
      "/packages/core/opensession-server/src/runner-host/host.ts",
    );
  });

  test("creates the user bin directory before linking the workload identity client", async () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-bootstrap-install-"));
    scratch.push(root);
    const config = join(root, "sandbox.json");
    writeFileSync(
      config,
      JSON.stringify({
        runnerRepoUrl: "https://github.com/tellahq/opensession.git",
        cloneCredential: { type: "https-token", token: "runner-clone-secret" },
      }),
    );
    process.env.OPENSESSION_SANDBOX_CONFIG = config;

    const commands: string[] = [];
    const driver: RemoteDriver = {
      async exec(command) {
        commands.push(command);
        if (command.startsWith("cat "))
          return { exitCode: 1, stdout: "", stderr: "" };
        if (
          command.includes(
            "test -f /home/ubuntu/projects/opensession/package.json",
          )
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };

    await bootstrapRemoteSandbox(driver, "test");

    const install = commands.find((command) =>
      command.includes(".local/bin/opensession"),
    );
    expect(install).toStartWith("mkdir -p /home/ubuntu/.local/bin && ");
    const compile = commands.find((command) =>
      command.includes("bun build --compile"),
    );
    expect(compile).toContain(
      "rm -f /home/ubuntu/.local/bin/opensession-runner",
    );
    const ghInstall = commands.find((command) =>
      command.includes("releases/download/v2.83.1"),
    );
    expect(ghInstall).toContain("sha256sum -c -");
    expect(ghInstall).toContain("/usr/local/bin/gh");
    const originScrub = commands.find((command) =>
      command.includes("remote set-url origin"),
    );
    expect(originScrub).toContain("https://github.com/tellahq/opensession.git");
    expect(originScrub).not.toContain("runner-clone-secret");
  });
});
