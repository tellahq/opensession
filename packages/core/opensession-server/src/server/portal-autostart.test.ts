import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { portalWorkspaceReady } from "./portal-autostart";
import { repoPortalStarter } from "./preview";

test("a Portal starts only once the session's workspace exists", () => {
  const host = { worktreeDir: "/w/acme-feature" };
  expect(portalWorkspaceReady(host, false)).toBe(true);
  expect(portalWorkspaceReady(host, true)).toBe(false);
  expect(portalWorkspaceReady({ worktreeDir: null }, false)).toBe(false);
  // A workspace Sandbox without its machine yet is still coming up.
  expect(
    portalWorkspaceReady({ ...host, sandbox: { provider: "box" } }, false),
  ).toBe(false);
  expect(
    portalWorkspaceReady(
      { ...host, sandbox: { provider: "box", sandboxId: "bx_1" } },
      false,
    ),
  ).toBe(true);
});

test("a repo offers its first Portal with a command", async () => {
  const root = mkdtempSync(join(tmpdir(), "portal-starter-"));
  try {
    expect(await repoPortalStarter(root)).toBeNull();
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents", "portals.json"),
      JSON.stringify({
        portals: [
          { id: "docs", name: "Docs" },
          { id: "app", name: "Acme app", command: "./start.sh" },
        ],
      }),
    );
    expect(await repoPortalStarter(root)).toEqual({
      id: "app",
      name: "Acme app",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
