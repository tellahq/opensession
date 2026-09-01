import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useSessionLifecycle.ts", import.meta.url),
).text();

function expectInOrder(source: string, needles: string[]) {
  let offset = 0;
  for (const needle of needles) {
    const index = source.indexOf(needle, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + needle.length;
  }
}

describe("session lifecycle ownership", () => {
  test("delegates lifecycle ownership to one hook instance", () => {
    expect(appSource.match(/useSessionLifecycle\(\{/g)).toHaveLength(1);
    expectInOrder(appSource, [
      "} = useWorkspaceMutations({",
      "} = useSessionLifecycle({",
      "const selectSessionTab =",
    ]);

    expect(appSource).not.toContain("const closeSessionNow =");
    expect(appSource).not.toContain("const closeSession =");
    expect(appSource).not.toContain("const deleteSessionFromTab =");
    expect(appSource).not.toContain("async function restoreSession");
    expect(appSource).not.toContain("const archiveSessionFromSidebar =");
    expect(appSource).not.toContain("const archiveSessionsFromCatchUp =");
    expect(appSource).not.toContain("const closeSessionRef =");
    expect(appSource).not.toContain("onArchive={(s, openNext) =>");
    expect(appSource).not.toContain("onArchive={(sessions) =>");

    expect(appSource).toContain("onArchive={archiveSessionFromSidebar}");
    expect(appSource).toContain("onArchive={archiveSessionsFromCatchUp}");
    expect(appSource).toContain("void closeSessionRef.current(s)");
  });

  test("owns every extracted callback and the synchronized close ref", () => {
    for (const name of [
      "closeSessionNow",
      "closeSession",
      "deleteSessionFromTab",
      "archiveSessionFromSidebar",
      "archiveSessionsFromCatchUp",
    ]) {
      expect(hookSource).toContain(`const ${name} =`);
    }
    expect(hookSource).toContain("async function restoreSession(");
    expect(hookSource).toContain(
      "const closeSessionRef = useRef(closeSession)",
    );
    expect(hookSource).toContain("useLayoutEffect(() => {");
    expect(hookSource).toContain("closeSessionRef.current = closeSession;");
  });

  test("preserves pending-create cleanup and close navigation ordering", () => {
    expectInOrder(hookSource, [
      "const closeSessionNow =",
      "abandonedSessionCreatesRef.current.add(s.id);",
      "clearTimeout(pendingTimer.current);",
      "setPendingSessionId(null);",
      "setOptimisticSession(null);",
      "unstick(s.id);",
      "if (neverRan) {",
      "remove(s.id);",
      'patch(s.id, { archived: true, archivedReason: "manual" });',
      "if (wasOpen) {",
      'navigate({ view: "session", id: next.id });',
      "setActiveViewTab(survivingPane);",
      "suppressWsSeedRef.current = true;",
      "navigate({",
      "try {",
      "await deleteSessionApi(s.id, false);",
      "await archiveSessionApi(s.id, true);",
      "rememberArchived([s.id]);",
      'console.error("Close failed:", e);',
      "setHiddenEmptySessionIds((hidden) => {",
      "inject(s);",
      "patch(s.id, { archived: false, archivedReason: undefined });",
      'navigate({ view: "session", id: s.id });',
      "needsNewSessionComposer",
      'navigate({ view: "workspace", id: activeWorkspaceId });',
      'openNewSessionInWorkspace(s, "share");',
      "refresh();",
    ]);
  });

  test("preserves delete and restore boundaries", () => {
    expectInOrder(hookSource, [
      "async function restoreSession",
      "await archiveSessionApi(s.id, false);",
      'console.error("Restore failed:", e);',
      "refresh();",
      "const closeSessionNow =",
    ]);
    expectInOrder(hookSource, [
      "const deleteSessionFromTab =",
      "await deleteSessionApi(session.id, cleanWorktree);",
      "remove(session.id);",
      'navigate({ view: "session", id: next.id });',
      'navigate({ view: "workspace", id: activeWorkspaceId });',
      "goBack();",
      "refresh();",
    ]);
  });

  test("preserves sidebar archive confirmation, rollback, and success ordering", () => {
    expectInOrder(hookSource, [
      "const archiveSessionFromSidebar =",
      "const wasOpen =",
      "openNext?.()",
      "goBack();",
      "patch(s.id",
      "await archiveSessionApi(s.id, true);",
      "rememberArchived([s.id]);",
      'console.error("Archive failed:", e);',
      "patch(s.id, {\n          archived: false,",
      'navigate({ view: "session", id: s.id });',
      "return;",
      "dropStalePins([s]);",
      "refresh();",
      "confirmRunningClose(s, () => void archive());",
    ]);
  });

  test("preserves Catch Up grouping, catch boundary, and unconditional refresh", () => {
    expectInOrder(hookSource, [
      "const archiveSessionsFromCatchUp =",
      "await Promise.all(",
      "sessions.map((c) => archiveSessionApi(c.id, true))",
      "rememberArchived(sessions.map((c) => c.id));",
      'console.error("Archive failed:", e);',
      "refresh();",
      "confirmRunningCloses(sessions, () => void archive());",
    ]);
  });

  test("exports only the hook", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain("export function useSessionLifecycle({");
  });
});
