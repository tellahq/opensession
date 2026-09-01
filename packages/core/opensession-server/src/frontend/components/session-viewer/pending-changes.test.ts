import { expect, test } from "bun:test";

test("parks the Changes diff while a new session is still being persisted", async () => {
  const source = await Bun.file(
    new URL("../SessionViewer.tsx", import.meta.url),
  ).text();

  expect(source).toContain(
    "!pendingCreation && hasRepoWork && (activePanelOpen || infoPageOpen)",
  );
});
