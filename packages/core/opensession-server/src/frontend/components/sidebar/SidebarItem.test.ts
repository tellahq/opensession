import { expect, test } from "bun:test";

async function source(): Promise<string> {
  return Bun.file(new URL("./SidebarItem.tsx", import.meta.url)).text();
}

test("session rows duplicate from desktop and phone action menus", async () => {
  const sidebarItem = await source();
  expect(sidebarItem).toContain(
    'const canDuplicate = session.source === "opensession" && !!session.ran;',
  );
  expect(sidebarItem).toContain("setPendingSessionFork(session.id);");
  expect(sidebarItem).toContain(
    "onDuplicate={canDuplicate ? duplicateSession : undefined}",
  );
  expect(sidebarItem.match(/Duplicate session/g)).toHaveLength(2);
});
