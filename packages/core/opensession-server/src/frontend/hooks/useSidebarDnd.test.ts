import { expect, test } from "bun:test";

const sidebarSource = await Bun.file(
  new URL("../components/Sidebar.tsx", import.meta.url),
).text();
const hookSource = await Bun.file(
  new URL("./useSidebarDnd.ts", import.meta.url),
).text();

test("sidebar drag, drop, and pin state live in useSidebarDnd", () => {
  expect(sidebarSource).toContain("useSidebarDnd({ onSetStatus })");
  expect(sidebarSource).toContain("drag={repoDrag}");
  expect(sidebarSource).toContain("createPinnedDrag(entries, isPhone)");
  expect(sidebarSource).not.toContain("const [pins, setPins]");
  expect(sidebarSource).not.toContain("function moveDraggedRepo");
  expect(sidebarSource).not.toContain("onPinsChanged");

  expect(hookSource).toContain("onPinsChanged(() => setPins(getPins()))");
  expect(hookSource).toContain("const moveDraggedRepo =");
  expect(hookSource).toContain("const createPinnedDrag =");
  expect(hookSource).toContain("onSetStatus(dragMeta.sessions, laneDrop.lane)");
});
