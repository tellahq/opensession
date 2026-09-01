import { describe, expect, test } from "bun:test";
import { isHiddenForSession, partitionHidden } from "./hides";

const row = (key: string, status: string) => ({ key, status });

describe("partitionHidden", () => {
  test("keeps rows with no hide entry visible", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "inprogress"), row("workspace:b", "pending")],
      {},
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced).toEqual([]);
  });

  test("hides a row the user hid", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "inprogress"), row("workspace:b", "pending")],
      { "workspace:a": "2026-07-31T10:00:00.000Z" },
    );
    expect([...hiddenKeys]).toEqual(["workspace:a"]);
    expect(resurfaced).toEqual([]);
  });

  // The safety net: hiding must never swallow a session that is waiting on a
  // human, so a blocked row comes back and its entry is handed to the caller
  // to consume.
  test("resurfaces a hidden row that is blocked on a question", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "needsinput")],
      { "workspace:a": "2026-07-31T10:00:00.000Z" },
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced.map((r) => r.key)).toEqual(["workspace:a"]);
  });

  test("resurfacing is per row: other hidden rows stay hidden", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [
        row("workspace:a", "needsinput"),
        row("workspace:b", "inprogress"),
        row("workspace:c", "merged"),
      ],
      {
        "workspace:a": "2026-07-31T10:00:00.000Z",
        "workspace:b": "2026-07-31T10:00:00.000Z",
      },
    );
    expect([...hiddenKeys]).toEqual(["workspace:b"]);
    expect(resurfaced.map((r) => r.key)).toEqual(["workspace:a"]);
  });

  // A hide entry whose row no longer exists (the session moved workspace, or a
  // solo session got absorbed into one) must not hide anything by accident.
  test("ignores stale entries that match no row", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "pending")],
      {
        "workspace:gone": "2026-07-31T10:00:00.000Z",
      },
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced).toEqual([]);
  });
});

describe("isHiddenForSession", () => {
  test("matches the workspace row that hides a linked session", () => {
    expect(
      isHiddenForSession(
        { id: "session-a", workspaceId: "linked" },
        { "workspace:linked": "2026-08-12T10:00:00.000Z" },
      ),
    ).toBe(true);
  });

  test("does not match an unrelated row hide", () => {
    expect(
      isHiddenForSession(
        { id: "session-a", workspaceId: "linked" },
        { "workspace:other": "2026-08-12T10:00:00.000Z" },
      ),
    ).toBe(false);
  });
});
