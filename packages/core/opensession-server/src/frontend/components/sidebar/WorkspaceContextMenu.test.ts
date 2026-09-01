import { expect, test } from "bun:test";

async function source(): Promise<string> {
  return Bun.file(
    new URL("./WorkspaceContextMenu.tsx", import.meta.url),
  ).text();
}

test("workspace rows duplicate the selected member session", async () => {
  const menu = await source();
  expect(menu).toContain(
    "sessions.find((session) => session.id === selectedSessionId) ?? first",
  );
  expect(menu).toContain('label: "Duplicate session"');
  expect(menu).toContain("onClick: () => onDuplicateSession(duplicateSource)");
});
