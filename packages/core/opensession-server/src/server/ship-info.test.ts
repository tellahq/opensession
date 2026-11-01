import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import { sessionShipInfo } from "./ship-info";
import type { UnifiedSession } from "./types";

const previousConfig = process.env.OPENSESSION_CONFIG;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ship-info-"));
  const path = join(dir, "config.json");
  process.env.OPENSESSION_CONFIG = path;
  writeFileSync(
    path,
    JSON.stringify({
      paths: { worktreesDir: join(dir, "worktrees") },
      repos: {
        app: { repo: join(dir, "app"), default: true },
        trunk: {
          repo: join(dir, "trunk"),
          publicationMode: "direct",
          sharedCheckout: true,
          shipActions: [
            { label: "Rebase", prompt: "Rebase onto origin/main." },
          ],
        },
      },
    }),
  );
  await getConfigAsync();
});

afterAll(async () => {
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
  await getConfigAsync();
  rmSync(dir, { recursive: true, force: true });
});

const session = (patch: Partial<UnifiedSession>) =>
  ({
    id: "os-ship",
    mode: "code",
    repo: "app",
    branch: "feat",
    worktreeDir: join(dir, "worktrees/app-feat"),
    ...patch,
  }) as UnifiedSession;

describe("sessionShipInfo", () => {
  test("a PR repository offers Create PR, then Update PR once one is open", async () => {
    const info = await sessionShipInfo(session({}));
    expect(info.available && info.mode).toBe("pull-request");
    expect(info.available && info.buttons.map((b) => b.label)).toEqual([
      "Create PR",
    ]);
    const open = await sessionShipInfo(
      session({
        prs: [
          {
            repo: "app",
            branch: "feat",
            source: "primary",
            state: "OPEN",
            number: 12,
          },
        ],
      }),
    );
    expect(open.available && open.openPr).toEqual({ number: 12 });
    expect(open.available && open.buttons[0].label).toBe("Update PR");
  });

  test("a session's Direct choice ships to the default branch", async () => {
    const info = await sessionShipInfo(session({ shipMode: "direct" }));
    expect(info.available && [info.mode, info.reason]).toEqual([
      "direct",
      "override",
    ]);
    expect(info.available && info.buttons[0].prompt).toContain(
      "git push origin HEAD:refs/heads/main",
    );
  });

  test("the repository's buttons follow Ship", async () => {
    const info = await sessionShipInfo(
      session({
        repo: "trunk",
        worktreeDir: join(dir, "worktrees/trunk-feat"),
      }),
    );
    expect(info.available && info.buttons.map((b) => b.label)).toEqual([
      "Ship",
      "Rebase",
    ]);
  });

  test("a shared checkout ships from the checkout itself", async () => {
    const info = await sessionShipInfo(
      session({
        repo: "trunk",
        branch: "main",
        worktreeDir: join(dir, "trunk"),
      }),
    );
    expect(info.available && [info.checkout, info.mode]).toEqual([
      "shared",
      "direct",
    ]);
    expect(info.available && info.buttons[0].prompt).toContain(
      "shared checkout",
    );
  });

  test("ask, scratch and repo-less sessions have nothing to ship", async () => {
    expect(await sessionShipInfo(session({ mode: "ask" }))).toEqual({
      available: false,
    });
    expect(await sessionShipInfo(session({ worktreeDir: undefined }))).toEqual({
      available: false,
    });
  });
});
