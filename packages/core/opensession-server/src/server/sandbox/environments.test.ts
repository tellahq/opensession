import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REPOS } from "../worktree";
import {
  connectSandboxProvider,
  setSandboxConnectionQualification,
  updateSandboxConnection,
} from "./connections";
import {
  invalidateSandboxEnvironmentsForRepo,
  listSandboxEnvironments,
  prepareSandboxEnvironment,
} from "./environments";

let scratch = "";
const previous: Record<string, string | undefined> = {};
const keys = [
  "OPENSESSION_SANDBOX_CONFIG",
  "OPENSESSION_WORKSPACE_SECRETS_STORE",
  "OPENSESSION_SANDBOX_ENVIRONMENTS_STORE",
  "OPENSESSION_SESSIONS_DIR",
] as const;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-environments-"));
  for (const key of keys) previous[key] = process.env[key];
  process.env.OPENSESSION_SANDBOX_CONFIG = join(scratch, "sandbox.json");
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
  process.env.OPENSESSION_SANDBOX_ENVIRONMENTS_STORE = join(
    scratch,
    "environments.json",
  );
  process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions");
});

afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("sandbox project environments", () => {
  test("every provider starts unprepared and a disabled connection removes readiness", async () => {
    const repo = Object.keys(REPOS)[0]!;
    connectSandboxProvider("daytona", { secret: "test-daytona-key" });
    setSandboxConnectionQualification("daytona", {
      status: "ready",
      checkedAt: new Date().toISOString(),
    });
    expect(
      (await listSandboxEnvironments()).find(
        (environment) =>
          environment.repo === repo && environment.provider === "daytona",
      ),
    ).toMatchObject({ state: "not_prepared" });

    updateSandboxConnection("daytona", { enabled: false });
    expect(
      (await listSandboxEnvironments()).find(
        (environment) =>
          environment.repo === repo && environment.provider === "daytona",
      )?.state,
    ).toBe("not_prepared");
  });

  test("rejects unknown repositories before allocating provider work", async () => {
    connectSandboxProvider("daytona", { secret: "test-daytona-key" });
    setSandboxConnectionQualification("daytona", { status: "ready" });
    await expect(
      prepareSandboxEnvironment("not-a-repository", "daytona"),
    ).rejects.toMatchObject({ code: "REPO_UNKNOWN" });
  });

  test("rejects invalid project machine settings before allocating provider work", async () => {
    const repo = Object.keys(REPOS)[0]!;
    connectSandboxProvider("daytona", { secret: "test-daytona-key" });
    setSandboxConnectionQualification("daytona", { status: "ready" });
    await expect(
      prepareSandboxEnvironment(repo, "daytona", { settings: { cpu: 0 } }),
    ).rejects.toMatchObject({ code: "MACHINE_SETTINGS_INVALID" });

    connectSandboxProvider("box", { secret: "test-box-key" });
    setSandboxConnectionQualification("box", { status: "ready" });
    await expect(
      prepareSandboxEnvironment(repo, "box", {
        settings: { cpu: 4, memoryMb: 8_192, diskGb: 40 },
      }),
    ).rejects.toMatchObject({ code: "MACHINE_SETTINGS_INVALID" });
  });

  test("marks every reusable provider template stale after a default-branch update", async () => {
    const repo = Object.keys(REPOS)[0]!;
    const path = process.env.OPENSESSION_SANDBOX_ENVIRONMENTS_STORE!;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        environments: ["daytona", "box"].map((provider) => ({
          repo,
          provider,
          state: "ready",
          mode: "template",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      }),
    );
    await invalidateSandboxEnvironmentsForRepo(repo);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.environments).toHaveLength(2);
    expect(
      stored.environments.every(
        (environment: any) => environment.state === "stale",
      ),
    ).toBe(true);
  });
});
