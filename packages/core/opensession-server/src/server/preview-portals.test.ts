import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getSandboxPreviewStatus,
  portalRouteAuthorized,
  previewServerConfig,
  writeSandboxPreviewAwsCredentials,
} from "./preview";
import type { Sandbox } from "./sandbox/provider";

describe("permission-coupled preview portals", () => {
  test("fails closed when Caddy retained a route the restarted server has not rediscovered", () => {
    expect(portalRouteAuthorized(29999)).toBe(false);
  });
  test("authenticates before proxying to the service", () => {
    const config = previewServerConfig(
      22001,
      "127.0.0.1:23001",
      "preview.example.test",
    ) as any;
    expect(config.listen).toEqual([":22001"]);
    const handles = config.routes[0].handle[0].routes[0].handle;
    expect(handles[0].rewrite).toEqual({
      method: "GET",
      uri: "/api/portal-auth/22001",
    });
    expect(handles[0].upstreams[0].dial).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(handles[0].handle_response[0].match.status_code).toEqual([2]);
    expect(handles[1].upstreams).toEqual([{ dial: "127.0.0.1:23001" }]);
  });

  test("refuses provider or private-network upstreams in Caddy", () => {
    expect(() =>
      previewServerConfig(
        22002,
        "https://sandbox-provider.example:443",
        "preview.example.test",
      ),
    ).toThrow("loopback relay");
    expect(() =>
      previewServerConfig(22003, "10.200.64.2:3300", "preview.example.test"),
    ).toThrow("loopback relay");
  });

  test("vends named AWS profiles without putting secrets in the command", async () => {
    const calls: Array<{
      cmd: string[];
      env?: Record<string, string>;
    }> = [];
    const sandbox = {
      id: "sandbox-test",
      exec: async (cmd: string[], opts?: { env?: Record<string, string> }) => {
        calls.push({ cmd, env: opts?.env });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as Sandbox;
    const secret = "secret-that-must-not-reach-command-text";
    const env = await writeSandboxPreviewAwsCredentials(
      sandbox,
      {
        AWS_ACCESS_KEY_ID: "test-key",
        AWS_SECRET_ACCESS_KEY: secret,
        AWS_SESSION_TOKEN: "test-token",
        AWS_REGION: "us-east-2",
      },
      "tella-dev",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd.join(" ")).not.toContain(secret);
    expect(calls[0].env?.AWS_SECRET_ACCESS_KEY).toBe(secret);
    expect(calls[0].env?.OPENSESSION_AWS_PROFILE).toBe("tella-dev");
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe(
      "/tmp/opensession-preview-aws/credentials",
    );
    expect(env.AWS_CONFIG_FILE).toBe("/tmp/opensession-preview-aws/config");
  });

  test("a stopped Portal whose port was taken over stays stopped and gets no URL", async () => {
    const port = 18_704;
    // A registered repo must own the worktree path, so stand the temp dir up
    // as a worktree of this repo rather than a bare scratch directory.
    const root = mkdtempSync(join(tmpdir(), "os-preview-portals-test-"));
    const worktree = join(root, "opensession-portal-status");
    mkdirSync(worktree);
    const previousRoot = process.env.OPENSESSION_WORKTREES_DIR;
    process.env.OPENSESSION_WORKTREES_DIR = root;
    const record = {
      name: "api",
      key: "PORTAL_API_PORT",
      command: "bun run api",
      port,
      state: "stopped",
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `# opensession-portal ${JSON.stringify(record)}\nPORTAL_API_PORT=${port}\n`,
    );
    // Something else is listening on the Portal's port: a survivor of a
    // failed kill, or an unrelated process that claimed it afterwards.
    const squatter = Bun.serve({ port, fetch: () => new Response("squatter") });
    try {
      const status = await getSandboxPreviewStatus(
        sandboxIn(worktree, port),
        worktree,
      );
      const api = status.services.find(
        (service) => service.key === "PORTAL_API_PORT",
      );
      expect(api).toMatchObject({
        state: "stopped",
        running: false,
        managed: true,
      });
      expect(api?.previewUrl ?? null).toBe(null);
      for (const service of status.services)
        expect(service.running).toBe(service.state === "awake");
    } finally {
      squatter.stop(true);
      if (previousRoot == null) delete process.env.OPENSESSION_WORKTREES_DIR;
      else process.env.OPENSESSION_WORKTREES_DIR = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function sandboxIn(cwd: string, port: number): Sandbox {
  return {
    id: "sandbox-preview-portals-test",
    provider: "docker",
    cwd,
    async exec(command: string[]) {
      const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    launchRun: () => {
      throw new Error("not used");
    },
    async ports() {
      return { [port]: port };
    },
    async status() {
      return "running";
    },
  } as unknown as Sandbox;
}
