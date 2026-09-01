import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  deployCheckout,
  deployStateDir,
  formatDeployStatus,
  isFrontendOnlyRelease,
  macDeployLaunchArgs,
  markerAgeMs,
  requiresRootDeploy,
  parseDeployResult,
  readDeployState,
  selfDeployHealthUrl,
  WATCHDOG_WINDOW_MS,
} from "./self-deploy";
import { parseMacSelfDeployArgs } from "../../../../../scripts/self-deploy-macos";
import { acquireMacDeployLock } from "./macos-deploy-lock";

const savedState = process.env.OPENSESSION_DEPLOY_STATE;
const savedCheckout = process.env.OPENSESSION_DEPLOY_CHECKOUT;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "os-self-deploy-"));
});

afterEach(() => {
  if (savedState === undefined) delete process.env.OPENSESSION_DEPLOY_STATE;
  else process.env.OPENSESSION_DEPLOY_STATE = savedState;
  if (savedCheckout === undefined)
    delete process.env.OPENSESSION_DEPLOY_CHECKOUT;
  else process.env.OPENSESSION_DEPLOY_CHECKOUT = savedCheckout;
  rmSync(dir, { recursive: true, force: true });
});

describe("parseDeployResult", () => {
  test("parses a script-written result", () => {
    const raw =
      '{"ok":true,"action":"deploy","sha":"abc123","previousSha":"def456","target":"origin/main","startedAt":"2026-08-04T10:00:00Z","finishedAt":"2026-08-04T10:01:00Z","durationSecs":60,"message":"deployed and healthy"}';
    const r = parseDeployResult(raw);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    expect(r!.action).toBe("deploy");
    expect(r!.sha).toBe("abc123");
    expect(r!.durationSecs).toBe(60);
  });

  test("rejects garbage, half-written and shape-less JSON", () => {
    expect(parseDeployResult("")).toBeNull();
    expect(parseDeployResult('{"ok":true,"action"')).toBeNull();
    expect(parseDeployResult("null")).toBeNull();
    expect(parseDeployResult('"a string"')).toBeNull();
    expect(parseDeployResult('{"ok":"yes","action":"deploy"}')).toBeNull();
    expect(parseDeployResult('{"ok":true}')).toBeNull();
  });
});

describe("markerAgeMs", () => {
  test("computes age from an epoch-seconds marker", () => {
    const now = 1_700_000_100_000;
    expect(markerAgeMs("1700000000\n", now)).toBe(100_000);
  });

  test("returns null for a missing/corrupt marker", () => {
    expect(markerAgeMs("", Date.now())).toBeNull();
    expect(markerAgeMs("not-a-number", Date.now())).toBeNull();
    expect(markerAgeMs("17000e3", Date.now())).toBeNull();
  });
});

describe("deployStateDir / deployCheckout", () => {
  test("env overrides win; defaults otherwise", () => {
    process.env.OPENSESSION_DEPLOY_STATE = "/tmp/x-state";
    process.env.OPENSESSION_DEPLOY_CHECKOUT = "/tmp/x-checkout";
    expect(deployStateDir()).toBe("/tmp/x-state");
    expect(deployCheckout()).toBe("/tmp/x-checkout");
    delete process.env.OPENSESSION_DEPLOY_STATE;
    delete process.env.OPENSESSION_DEPLOY_CHECKOUT;
    expect(deployStateDir().endsWith("/.opensession/deploy")).toBe(true);
    // Default checkout is this repo (the running instance's own tree).
    expect(deployCheckout()).toBe(resolve(import.meta.dir, "../../../../.."));
  });
});

describe("readDeployState", () => {
  test("empty state dir degrades to nulls", () => {
    const s = readDeployState(dir);
    expect(s.pin).toBeNull();
    expect(s.markerAgeMs).toBeNull();
    expect(s.result).toBeNull();
  });

  test("reads pin + marker + result together", () => {
    const now = 1_700_000_600_000;
    writeFileSync(join(dir, "last-known-good"), "abc123def456\n");
    writeFileSync(join(dir, "last-deploy-marker"), "1700000000\n");
    writeFileSync(
      join(dir, "last-result.json"),
      '{"ok":false,"action":"rollback-needed","sha":"badbadbad1","previousSha":"abc123def456","message":"unhealthy; tree left"}',
    );
    const s = readDeployState(dir, now);
    expect(s.pin).toBe("abc123def456");
    expect(s.markerAgeMs).toBe(600_000);
    expect(s.result!.action).toBe("rollback-needed");
  });
});

describe("formatDeployStatus", () => {
  test("no result yet", () => {
    const out = formatDeployStatus(
      { pin: null, markerAgeMs: null, result: null },
      dir,
    );
    expect(out).toContain("No self-deploy result recorded yet");
    expect(out).toContain("pin: none recorded");
    expect(out).toContain("Watchdog window: closed");
  });

  test("healthy deploy with open watchdog window", () => {
    const out = formatDeployStatus(
      {
        pin: "abc123def456",
        markerAgeMs: 2 * 60_000,
        result: {
          ok: true,
          action: "deploy",
          sha: "feedfacefeed",
          target: "origin/main",
          finishedAt: "2026-08-04T10:01:00Z",
          durationSecs: 45,
          message: "deployed and healthy",
        },
      },
      dir,
    );
    expect(out).toContain("Last self-deploy: OK (deploy)");
    expect(out).toContain("feedfacefe");
    expect(out).toContain("pin: abc123def4");
    expect(out).toContain("Watchdog window: OPEN");
  });

  test("an old marker is reported as an expired window", () => {
    const out = formatDeployStatus(
      {
        pin: "abc123def456",
        markerAgeMs: WATCHDOG_WINDOW_MS + 60_000,
        result: null,
      },
      dir,
    );
    expect(out).toContain("Watchdog window: closed");
    expect(out).toContain("rollback window expired");
  });

  test("rollback-needed surfaces the manual action", () => {
    const out = formatDeployStatus(
      {
        pin: "abc123def456",
        markerAgeMs: null,
        result: {
          ok: false,
          action: "rollback-needed",
          sha: "badbadbad111",
          previousSha: "abc123def456",
          message: "unhealthy after deploy; tree left",
        },
      },
      dir,
    );
    expect(out).toContain("FAILED (rollback-needed)");
    expect(out).toContain("ACTION NEEDED");
    expect(out).toContain("abc123def4");
  });
});

describe("requiresRootDeploy", () => {
  test("requires the privileged rollout for installed deploy and service artifacts", () => {
    for (const path of [
      "deploy/deploy.sh",
      "deploy/self-deploy.sh",
      "deploy/release-checkout.sh",
      "deploy/install-executor-credential.sh",
      "deploy/install-session-kernel-credential.sh",
      "deploy/install-run-host-helper.sh",
      "deploy/install-resource-control.sh",
      "deploy/opensession-run-host",
      "deploy/systemd/opensession-session-kernel.service.d/capacity.conf",
      "opensession.service",
      "opensession.socket",
      "opensession-ingress.service",
      "opensession-executor.service",
      "opensession-session-kernel.service",
      "packages/core/opensession-server/src/server/gateway-ingress.ts",
      "packages/core/opensession-server/src/server/gateway-routing.ts",
      "packages/core/opensession-server/src/server/gateway-tcp-proxy.ts",
      "packages/core/opensession-server/src/server/stable-frontend.ts",
    ]) {
      expect(requiresRootDeploy([path], "linux")).toBe(true);
    }
  });

  test("does not escalate ordinary source, frontend, or documentation changes", () => {
    expect(
      requiresRootDeploy([
        "packages/core/opensession-server/src/server/routes/system.ts",
        "packages/core/opensession-server/src/frontend/App.tsx",
        "docs/self-development.md",
      ]),
    ).toBe(false);
  });

  test("does not require Linux root artifacts on macOS", () => {
    expect(
      requiresRootDeploy(
        [
          "opensession.service",
          "deploy/systemd/opensession-watchdog.service",
          "packages/core/opensession-server/src/server/gateway-tcp-proxy.ts",
        ],
        "darwin",
      ),
    ).toBe(false);
  });
});

describe("isFrontendOnlyRelease", () => {
  test("accepts frontend source plus documentation", () => {
    expect(
      isFrontendOnlyRelease([
        "packages/core/opensession-server/src/frontend/App.tsx",
        "packages/core/opensession-server/src/frontend/styles/base.css",
        "docs/self-development.md",
      ]),
    ).toBe(true);
  });

  test("requires a frontend change", () => {
    expect(
      isFrontendOnlyRelease(["docs/self-development.md", "AGENTS.md"]),
    ).toBe(false);
  });

  test("falls back for any server, dependency, protocol, or deploy path", () => {
    for (const path of [
      "packages/core/opensession-server/src/server/routes/system.ts",
      "package.json",
      "bun.lock",
      "deploy/self-deploy.sh",
    ]) {
      expect(
        isFrontendOnlyRelease([
          "packages/core/opensession-server/src/frontend/App.tsx",
          path,
        ]),
      ).toBe(false);
    }
  });
});

describe("macOS self-deploy launcher", () => {
  test("targets the configured server address for health checks", () => {
    expect(selfDeployHealthUrl({ HOST: "100.81.254.102", PORT: "4850" })).toBe(
      "http://100.81.254.102:4850/ready",
    );
    expect(selfDeployHealthUrl({ HOST: "::1" })).toBe(
      "http://[::1]:3850/ready",
    );
    expect(
      selfDeployHealthUrl({
        OPENSESSION_HEALTH_URL: "http://localhost:9999/health",
      }),
    ).toBe("http://localhost:9999/health");
  });

  test("serializes launchd deploys and frontend promotions without flock", async () => {
    const release = await acquireMacDeployLock(dir, 20, 1);
    await expect(acquireMacDeployLock(dir, 5, 1)).rejects.toThrow(
      "timed out waiting for the active macOS deploy",
    );
    release();
    const nextRelease = await acquireMacDeployLock(dir, 20, 1);
    nextRelease();
  });

  test("submits a detached launchd job without sudo or shell interpolation", () => {
    const args = macDeployLaunchArgs({
      unit: "opensession-self-deploy-1700000000000",
      targetSha: "a".repeat(40),
      checkout: "/Users/test/Open Session",
      stateDir: "/Users/test/.opensession/deploy",
      bun: "/Users/test/.bun/bin/bun",
      home: "/Users/test",
      healthUrl: "http://127.0.0.1:3850/ready",
      controller: "/Users/test/Open Session/scripts/self-deploy-macos.ts",
    });
    expect(args.slice(0, 4)).toEqual([
      "launchctl",
      "submit",
      "-l",
      "opensession-self-deploy-1700000000000",
    ]);
    expect(args).toContain("/Users/test/Open Session");
    expect(
      args.slice(args.indexOf("--unit"), args.indexOf("--unit") + 2),
    ).toEqual(["--unit", "opensession-self-deploy-1700000000000"]);
    expect(args).not.toContain("sudo");
    expect(args).not.toContain("/bin/sh");
    expect(args.at(-1)).toBe("http://127.0.0.1:3850/ready");
  });

  test("requires an exact SHA and absolute trusted paths", () => {
    const valid = [
      "--unit",
      "opensession-self-deploy-1700000000000",
      "--sha",
      "b".repeat(40),
      "--checkout",
      "/repo",
      "--state",
      "/state",
      "--bun",
      "/bin/bun",
      "--home",
      "/Users/test",
      "--health-url",
      "http://127.0.0.1:3850/ready",
    ];
    expect(parseMacSelfDeployArgs(valid).target).toBe("b".repeat(40));
    expect(() =>
      parseMacSelfDeployArgs(
        valid.map((value) => (value === "/repo" ? "relative/repo" : value)),
      ),
    ).toThrow("--checkout must be absolute");
    expect(() =>
      parseMacSelfDeployArgs(
        valid.map((value) =>
          value === "b".repeat(40) ? "origin/main" : value,
        ),
      ),
    ).toThrow("--sha must be an exact commit");
    expect(() =>
      parseMacSelfDeployArgs(
        valid.map((value) =>
          value === "opensession-self-deploy-1700000000000"
            ? "other-job"
            : value,
        ),
      ),
    ).toThrow("--unit is not a self-deploy launchd label");
  });
});

describe("deploy/self-deploy.sh", () => {
  test("passes bash -n (syntax)", () => {
    const script = resolve(
      import.meta.dir,
      "../../../../../deploy/self-deploy.sh",
    );
    const proc = Bun.spawnSync(["bash", "-n", script]);
    expect(proc.exitCode).toBe(0);
  });

  test("passes configured storage paths to the offline actor migration", async () => {
    const script = await Bun.file(
      resolve(import.meta.dir, "../../../../../deploy/self-deploy.sh"),
    ).text();
    expect(script).toContain("read_env_value OPENSESSION_STATE_DIR");
    expect(script).toContain("read_env_value OPENSESSION_SESSIONS_DIR");
    expect(script).toContain('migration_env+=("OPENSESSION_STATE_DIR=');
    expect(script).toContain('migration_env+=("OPENSESSION_SESSIONS_DIR=');
    expect(script).toContain("migrate-session-kernel-storage.ts");
    expect(script).toContain(
      'merge-base --is-ancestor "$current" "$target_sha"',
    );
    expect(script).toContain("refusing stale/parallel release");
    expect(script).toContain('flock -w "$DEPLOY_LOCK_WAIT_SECS"');
    expect(script).toContain("already deployed or superseded");
    expect(script).toContain("into newest requested target");
    expect(script).toContain("refusing an automatic queued retry");
    expect(script).toContain("DEPLOY_COALESCE_SECS:-15");
    expect(script).toContain("DEPLOY_COALESCE_MAX_SECS:-60");
    expect(script).toContain("quiet_deadline=$((now + DEPLOY_COALESCE_SECS))");
    expect(script).toContain("restart_kernel=1 restart_executor_peer=1");
    expect(script).not.toContain("restart_kernel=0");
    expect(script).not.toContain("restart_executor_peer=0");
    expect(script).toContain(
      'kernel_generation="$target_sha" executor_generation="$target_sha"',
    );
    expect(script).toContain(
      'refresh_protocol_peers "$restart_executor_peer" "$restart_kernel"',
    );
    expect(script).toContain(
      '"$release_dir" "$target_sha" "$kernel_generation" "$executor_generation"',
    );
    expect(script).toContain(
      "candidate gateway handoff failed before cut-over; previous gateway remains healthy",
    );
    expect(script).toContain(
      "gateway handoff failed and the previous gateway is not healthy; forcing rollback",
    );
    expect(script).toContain("forced rollback restored health");
  });

  test("the server launches through the fixed privileged helper", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "self-deploy.ts"),
    ).text();
    expect(source).toContain('RUN_HOST_HELPER, "self-deploy"');
    expect(source).toContain("Deployment may be autonomous");
    expect(source).toContain(
      "queue and coalesce to the newest fast-forward target",
    );
    expect(source).toContain("strictly frontend-only diff");
    expect(source).toContain("without restarting any service");
    expect(source).toContain('"--no-renames"');
    expect(source).toContain("requiresRootDeploy(paths)");
    expect(source).toContain("Refusing unprivileged self-deploy");
    expect(source).toContain("only rebuilds the already pinned source");
    expect(source).toContain("No separate human approval is required");
    expect(source).toContain("nextDeployUnitName()");
    expect(source).toContain("Migration path for instances upgrading");
    expect(source).toContain('platform() === "darwin"');
    expect(source).toContain("macDeployLaunchArgs");
    expect(source).toContain(
      "Environment=OPENSESSION_BUN_BIN=${process.execPath}",
    );
    expect(source).toContain("Environment=OPENSESSION_STATE_DIR=");
    expect(source).toContain("Environment=OPENSESSION_SESSIONS_DIR=");
    const deployTool = source.indexOf(
      "async (args: { sha?: string; confirm: boolean })",
    );
    const stateDir = source.indexOf(
      "const stateDir = deployStateDir();",
      deployTool,
    );
    const runtime = source.indexOf(
      "const runtime = `${stateDir}/current`;",
      deployTool,
    );
    expect(stateDir).toBeGreaterThan(deployTool);
    expect(stateDir).toBeLessThan(runtime);
    const helper = await Bun.file(
      resolve(import.meta.dir, "../../../../../deploy/opensession-run-host"),
    ).text();
    expect(helper).toContain('-p "EnvironmentFile=$env_file"');
    expect(helper).toContain('-p "Environment=OPENSESSION_BUN_BIN=$bun_bin"');
  });
});

describe("deploy/release-checkout.sh", () => {
  test("builds and validates the candidate frontend before returning it", () => {
    const source = join(dir, "source");
    const state = join(dir, "state");
    const fakeBun = join(dir, "bun");
    const calls = join(dir, "bun-calls");
    mkdirSync(source);
    mkdirSync(state);
    writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`,
    );
    chmodSync(fakeBun, 0o755);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "release-test@example.invalid"],
      ["config", "user.name", "Release Test"],
    ]) {
      expect(Bun.spawnSync(["git", "-C", source, ...args]).exitCode).toBe(0);
    }
    writeFileSync(join(source, "app.txt"), "committed\n");
    expect(
      Bun.spawnSync(["git", "-C", source, "add", "app.txt"]).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "-C", source, "commit", "-qm", "initial"]).exitCode,
    ).toBe(0);
    const sha = new TextDecoder()
      .decode(Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout)
      .trim();
    const script = resolve(
      import.meta.dir,
      "../../../../../deploy/release-checkout.sh",
    );
    const prepared = Bun.spawnSync(["bash", script, "prepare-frontend", sha], {
      env: {
        ...process.env,
        OPENSESSION_DEPLOY_CHECKOUT: source,
        OPENSESSION_DEPLOY_STATE: state,
        OPENSESSION_BUN_BIN: fakeBun,
      },
    });
    expect(prepared.exitCode).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile",
      "run scripts/build-frontend.ts",
      "run scripts/validate-frontend-build.ts",
    ]);
  });

  test("prepares and atomically selects a commit without changing dirty WIP", () => {
    const source = join(dir, "source");
    const state = join(dir, "state");
    const fakeBun = join(dir, "bun");
    mkdirSync(source);
    mkdirSync(state);
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "release-test@example.invalid"],
      ["config", "user.name", "Release Test"],
    ]) {
      expect(Bun.spawnSync(["git", "-C", source, ...args]).exitCode).toBe(0);
    }
    writeFileSync(join(source, "app.txt"), "committed\n");
    expect(
      Bun.spawnSync(["git", "-C", source, "add", "app.txt"]).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "-C", source, "commit", "-qm", "initial"]).exitCode,
    ).toBe(0);
    const sha = new TextDecoder()
      .decode(Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout)
      .trim();
    writeFileSync(join(source, "app.txt"), "unfinished WIP\n");

    const script = resolve(
      import.meta.dir,
      "../../../../../deploy/release-checkout.sh",
    );
    const env = {
      ...process.env,
      OPENSESSION_DEPLOY_CHECKOUT: source,
      OPENSESSION_DEPLOY_STATE: state,
      OPENSESSION_BUN_BIN: fakeBun,
    };
    const prepared = Bun.spawnSync(["bash", script, "prepare", sha], { env });
    expect(prepared.exitCode).toBe(0);
    const release = new TextDecoder().decode(prepared.stdout).trim();
    expect(readFileSync(join(release, "app.txt"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(source, "app.txt"), "utf8")).toBe(
      "unfinished WIP\n",
    );
    expect(
      Bun.spawnSync(["bash", script, "switch", sha], { env }).exitCode,
    ).toBe(0);
    expect(readlinkSync(join(state, "current"))).toBe(release);
  });
});
