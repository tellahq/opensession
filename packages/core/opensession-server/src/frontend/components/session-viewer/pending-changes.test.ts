import { expect, test } from "bun:test";

test("parks the Changes diff while a new session is still being persisted", async () => {
  const source = await Bun.file(
    new URL(
      "../../hooks/useSessionWorkspaceToolsController.ts",
      import.meta.url,
    ),
  ).text();

  expect(source).toContain("!identity.pendingCreation &&");
  expect(source).toContain("runtime.hasRepoWork &&");
  expect(source).toContain("(runtime.activePanelOpen || runtime.infoPageOpen)");
});
