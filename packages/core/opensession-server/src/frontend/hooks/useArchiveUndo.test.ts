import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useArchiveUndo.ts", import.meta.url),
).text();
const lifecycleSource = await Bun.file(
  new URL("useSessionLifecycle.ts", import.meta.url),
).text();
const workspaceMutationsSource = await Bun.file(
  new URL("useWorkspaceMutations.ts", import.meta.url),
).text();

describe("archive undo ownership", () => {
  test("delegates archive undo once from App", () => {
    expect(appSource.match(/useArchiveUndo\(\{/g)).toHaveLength(1);
    expect(appSource).not.toContain("setArchiveUndo");
    expect(appSource).not.toContain("const [archiveUndo");
    expect(appSource).not.toContain("Nothing to reopen");
  });

  test("keeps archive recording at each lifecycle owner", () => {
    expect(lifecycleSource).toContain("rememberArchived([s.id])");
    expect(lifecycleSource).toContain(
      "rememberArchived(sessions.map((c) => c.id))",
    );
    expect(workspaceMutationsSource).toContain(
      "rememberArchived(members.map((member) => member.id))",
    );
    expect(appSource).toContain("rememberArchived([viewerSession.id])");
    expect(appSource).toContain("unarchiveSession(currentSession)");
    expect(appSource).toContain("void reopenLastArchivedRef.current()");
    expect(appSource).toContain("run: () => void reopenLastArchived()");
  });

  test("keeps the bounded, deduplicated stack contract", () => {
    expect(hookSource).toContain(".slice(-10)");
    expect(hookSource.indexOf("forgetLastSession(ids);")).toBeLessThan(
      hookSource.indexOf("setArchiveUndo((prev)"),
    );
    expect(hookSource).toContain("entry.filter((id) => !ids.includes(id))");
    expect(hookSource).toContain(
      "for (let i = archiveUndo.length - 1; i >= 0; i--)",
    );
  });

  test("keeps optimistic unarchive and rollback ordering", () => {
    expect(hookSource).toContain(
      "const reasons = new Map(sessions.map((c) => [c.id, c.archivedReason]))",
    );
    expect(hookSource).toContain("archiveSessionApi(c.id, false)");
    expect(hookSource).toContain(
      "patch(c.id, { archived: true, archivedReason: reasons.get(c.id) })",
    );
    expect(hookSource).toContain(
      "if (!(await unarchiveSessions(sessions))) return;",
    );
    expect(
      hookSource.indexOf("if (!(await unarchiveSessions(sessions))) return;"),
    ).toBeLessThan(hookSource.lastIndexOf("setArchiveUndo"));
  });

  test("keeps latest-value refs for the shortcut", () => {
    expect(hookSource).toContain(
      "restorableArchivedRef.current = restorableArchived",
    );
    expect(hookSource).toContain(
      "reopenLastArchivedRef.current = reopenLastArchived",
    );
  });

  test("exports only the hook", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain("export function useArchiveUndo({");
  });
});
