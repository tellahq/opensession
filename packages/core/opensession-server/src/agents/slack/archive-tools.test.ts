import { beforeEach, describe, expect, mock, test } from "bun:test";

type FakeSession = { id: string; workspaceId?: string; archived?: boolean };

const sessions = new Map<string, FakeSession>();
const calls: Array<{ id: string; archived: boolean }> = [];

mock.module("../../server/audit", () => ({ audit: () => {} }));
mock.module("../../server/session-cache", () => ({
  findSessionAsync: async (id: string) => sessions.get(id) ?? null,
  getSessionListSnapshotAsync: async (slice = "include") =>
    [...sessions.values()].filter((session) =>
      slice === "only"
        ? session.archived
        : slice === "exclude"
          ? !session.archived
          : true,
    ),
}));
mock.module("../../server/session-archive-action", () => ({
  setSessionArchivedState: async (session: FakeSession, archived: boolean) => {
    calls.push({ id: session.id, archived });
    session.archived = archived;
    return { stoppedRun: false };
  },
}));

const { archiveTools } = await import("./archive-tools");

async function call(name: string, args: Record<string, unknown>) {
  const found = archiveTools({
    createdBy: "Ada",
    currentSessionId: "bks-current",
  }).find((t) => t.name === name);
  const result = await found.handler(args, {});
  return result.content[0].text as string;
}

beforeEach(() => {
  calls.length = 0;
  sessions.clear();
  for (const s of [
    { id: "bks-current", workspaceId: "ws-live" },
    { id: "bks-a", workspaceId: "ws-old", archived: true },
    { id: "bks-b", workspaceId: "ws-old", archived: true },
    { id: "bks-c", workspaceId: "ws-live" },
    { id: "bks-other", workspaceId: "ws-other", archived: true },
  ])
    sessions.set(s.id, { ...s });
});

describe("archive_session", () => {
  test("unarchives an archived session", async () => {
    expect(
      await call("archive_session", { id: "bks-a", archived: false }),
    ).toBe("Unarchived `bks-a`.");
    expect(calls).toEqual([{ id: "bks-a", archived: false }]);
  });

  test("archives by default and skips no-ops", async () => {
    expect(await call("archive_session", { id: "bks-c" })).toBe(
      "Archived `bks-c`.",
    );
    expect(await call("archive_session", { id: "bks-c" })).toContain(
      "already archived",
    );
    expect(calls).toEqual([{ id: "bks-c", archived: true }]);
  });

  test("refuses to archive the calling session", async () => {
    expect(await call("archive_session", { id: "bks-current" })).toContain(
      "cannot archive itself",
    );
    expect(calls).toEqual([]);
  });

  test("reports unknown ids", async () => {
    expect(await call("archive_session", { id: "bks-nope" })).toContain(
      "No session",
    );
  });
});

describe("archive_workspace", () => {
  test("unarchives only that workspace's archived sessions", async () => {
    const out = await call("archive_workspace", {
      workspace_id: "ws-old",
      archived: false,
    });
    expect(out).toContain("Unarchived 2 session(s)");
    expect(calls).toEqual([
      { id: "bks-a", archived: false },
      { id: "bks-b", archived: false },
    ]);
  });

  test("archives live members but never the calling session", async () => {
    await call("archive_workspace", { workspace_id: "ws-live" });
    expect(calls).toEqual([{ id: "bks-c", archived: true }]);
  });

  test("says when nothing matches", async () => {
    expect(
      await call("archive_workspace", {
        workspace_id: "ws-live",
        archived: false,
      }),
    ).toContain("has no archived sessions");
  });
});
