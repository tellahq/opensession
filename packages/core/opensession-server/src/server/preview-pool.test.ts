import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cloneUrlFor, rebuildInvalidatedPreviewPool } from "./preview-pool";
import type { Repo } from "./config";

describe("default branch preview-pool rebuild", () => {
  test("does not refill a golden-backed pool when its rebuild fails", async () => {
    let refills = 0;

    const rebuilt = await rebuildInvalidatedPreviewPool(
      "docker",
      async () => false,
      async () => {
        refills++;
      },
    );

    expect(rebuilt).toBe(false);
    expect(refills).toBe(0);
  });

  test("refills after success and lets Daytona provision without a golden", async () => {
    let rebuilds = 0;
    let refills = 0;
    const rebuild = async () => {
      rebuilds++;
      return true;
    };
    const refill = async () => {
      refills++;
    };

    await expect(
      rebuildInvalidatedPreviewPool("microvm", rebuild, refill),
    ).resolves.toBe(true);
    await expect(
      rebuildInvalidatedPreviewPool("daytona", rebuild, refill),
    ).resolves.toBe(true);
    expect(rebuilds).toBe(1);
    expect(refills).toBe(2);
  });
});

describe("preview pool GitHub credential cutover", () => {
  test("does not bake an expiring App token into restartable container commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-preview-credential-"));
    const previous = process.env.OPENSESSION_CONFIG;
    try {
      const config = join(dir, "config.json");
      writeFileSync(config, JSON.stringify({ integrations: { github: {} } }));
      process.env.OPENSESSION_CONFIG = config;
      expect(
        await cloneUrlFor(
          {
            id: "opensession",
            label: "Open Session",
            repo: "/host/opensession",
            wtPrefix: "/host/worktrees/opensession",
            defaultBranch: "main",
            host: "github",
            ghRepo: "tellahq/opensession",
          } satisfies Repo,
          { longLived: true },
        ),
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPENSESSION_CONFIG;
      else process.env.OPENSESSION_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
