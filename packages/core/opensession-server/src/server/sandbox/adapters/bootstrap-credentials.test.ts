import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { warmRemoteWorkspace } from "./bootstrap";
import type { RemoteDriver } from "./bootstrap";

describe("GitHub clone credential boundary", () => {
  test("scrubs a warm origin before repository dependency code runs", async () => {
    const commands: string[] = [];
    const driver = {
      exec: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await warmRemoteWorkspace(
      driver as unknown as RemoteDriver,
      {
        id: "opensession",
        repo: "/host/opensession",
        ghRepo: "tellahq/opensession",
        defaultBranch: "main",
      },
      "test",
    );

    const scrub = commands.findIndex((command) =>
      command.includes("remote set-url origin"),
    );
    const deps = commands.findIndex((command) =>
      command.includes("install --frozen-lockfile"),
    );
    expect(scrub).toBeGreaterThanOrEqual(0);
    expect(deps).toBeGreaterThan(scrub);
  });
});

describe("model credential boundary", () => {
  test("no Sandbox adapter can reach a model credential store", () => {
    // The agent loop runs on this server; nothing a Sandbox is prepared or
    // driven with may import the account pools or model provider config.
    for (const file of [
      "bootstrap.ts",
      "box.ts",
      "daytona.ts",
      "tart.ts",
      "usecomputer.ts",
    ]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      for (const store of [
        "claude-accounts",
        "codex-accounts",
        "xai-accounts",
        "openai-auth",
        "model-providers",
        "pi-config",
      ])
        expect(`${file}: ${source.includes(`/${store}"`)}`).toBe(
          `${file}: false`,
        );
    }
  });
});
