import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "../lib/types";
import {
  loadWorkspaces,
  subscribeToWorkspaceRefreshes,
  useWorkspaces,
} from "./useWorkspaces";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useWorkspaces.ts", import.meta.url),
).text();
const mutationsSource = await Bun.file(
  new URL("useWorkspaceMutations.ts", import.meta.url),
).text();

function expectInOrder(source: string, needles: string[]) {
  let offset = 0;
  for (const needle of needles) {
    const index = source.indexOf(needle, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + needle.length;
  }
}

function workspace(id: string): Workspace {
  return { id, name: `Workspace ${id}` } as Workspace;
}

describe("workspace loading", () => {
  test("commits rows before loaded settles and the refresh resolves", async () => {
    const rows = [workspace("one")];
    const order: string[] = [];
    let resolve!: (workspaces: Workspace[]) => void;
    const response = new Promise<Workspace[]>((settle) => {
      resolve = settle;
    });

    const refresh = loadWorkspaces(
      () => response,
      (next) => {
        expect(next).toBe(rows);
        order.push("rows");
      },
      () => order.push("loaded"),
    );
    void refresh.then(() => order.push("resolved"));

    expect(order).toEqual([]);
    resolve(rows);
    await refresh;
    expect(order).toEqual(["rows", "loaded", "resolved"]);
  });

  test("commits an empty successful response and marks loaded", async () => {
    let current = [workspace("existing")];
    let loaded = false;

    await loadWorkspaces(
      async () => [],
      (next) => {
        current = next;
      },
      () => {
        loaded = true;
      },
    );

    expect(current).toEqual([]);
    expect(loaded).toBe(true);
  });

  test("swallows an unexpected rejection, preserves rows, and marks loaded", async () => {
    const prior = [workspace("existing")];
    let current = prior;
    let loaded = false;

    await loadWorkspaces(
      async () => {
        throw new Error("unexpected");
      },
      (next) => {
        current = next;
      },
      () => {
        loaded = true;
      },
    );

    expect(current).toBe(prior);
    expect(loaded).toBe(true);
  });
});

test("refreshes on mount and workspace invalidation events until cleanup", () => {
  const target = new EventTarget();
  let refreshes = 0;
  const cleanup = subscribeToWorkspaceRefreshes(target, () => {
    refreshes += 1;
  });

  expect(refreshes).toBe(1);
  target.dispatchEvent(new Event("focus"));
  expect(refreshes).toBe(2);
  target.dispatchEvent(new Event("opensession:workspaces-changed"));
  expect(refreshes).toBe(3);

  cleanup();
  target.dispatchEvent(new Event("focus"));
  target.dispatchEvent(new Event("opensession:workspaces-changed"));
  expect(refreshes).toBe(3);
});

test("has a server-safe unloaded initial snapshot", () => {
  function Snapshot() {
    const { workspaces, loaded } = useWorkspaces();
    return createElement("output", null, `${workspaces.length}:${loaded}`);
  }

  expect(renderToStaticMarkup(createElement(Snapshot))).toBe(
    "<output>0:false</output>",
  );
});

test("delegates list ownership while keeping refresh identity explicit", () => {
  expect(appSource).toContain("} = useWorkspaces();");
  expect(appSource).not.toContain("setWorkspaces");
  expect(appSource).not.toContain('"opensession:workspaces-changed"');
  expect(hookSource).toMatch(
    /const \[refresh\] = useState\(\s*\(\) => \(\) =>/,
  );
});

test("delegates workspace mutation ownership to one hook instance", () => {
  expect(appSource.match(/useWorkspaceMutations\(\{/g)).toHaveLength(1);
  expect(appSource).not.toContain("const archiveWorkspaceFromHeader");
  expect(appSource).not.toContain("const deleteWorkspaceFromHeader");
  expect(appSource).not.toContain("updateWorkspaceApi");
  expect(appSource).not.toContain("deleteWorkspaceApi");

  for (const name of [
    "renameWorkspace",
    "renameWorkspaceFromSidebar",
    "archiveWorkspaceFromHeader",
    "archiveWorkspaceFromSidebar",
    "deleteWorkspaceFromHeader",
    "deleteWorkspaceFromSidebar",
  ]) {
    expect(mutationsSource).toContain(`const ${name} =`);
  }
});

test("preserves workspace mutation ordering and failure boundaries", () => {
  expect(mutationsSource).toContain("if (!members.length) return;");
  expectInOrder(mutationsSource, [
    "const archiveWorkspaceFromHeader",
    "goBack();",
    "patch(member.id",
    "await Promise.all(",
    "rememberArchived(",
    "dropStalePins(members);",
    "refreshSessions();",
    'console.error("Archive workspace failed:", error);',
  ]);
  expectInOrder(mutationsSource, [
    "const renameWorkspace =",
    "await updateWorkspaceApi",
    'console.error("Rename workspace failed:", error);',
    "refreshWorkspaces();",
    "const renameWorkspaceFromSidebar =",
    "await updateWorkspaceApi",
    "refreshWorkspaces();",
    'console.error("Rename workspace failed:", error);',
  ]);
  expectInOrder(mutationsSource, [
    "const deleteWorkspaceFromHeader",
    "await deleteWorkspaceApi(workspaceId);",
    "refreshWorkspaces();",
    "refreshSessions();",
    'route.view === "workspace"',
    "goBack();",
    "const deleteWorkspaceFromSidebar",
    "const wasOpen =",
    "await deleteWorkspaceApi(workspaceId);",
    'console.error("Delete workspace failed:", error);',
    "refreshWorkspaces();",
    "refreshSessions();",
    'navigate({ view: "prs" });',
  ]);
  expectInOrder(mutationsSource, [
    "const archiveWorkspaceFromSidebar",
    "const openSessionId =",
    "openNext?.()",
    "patch(session.id",
    "await Promise.all(",
    "rememberArchived(",
    'console.error("Archive workspace failed:", error);',
    'navigate({ view: "session", id: openSessionId });',
    "dropStalePins(sessions);",
    "refreshSessions();",
  ]);
});
