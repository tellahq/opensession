import { describe, expect, test } from "bun:test";
import { reconcileDrafts, type DraftSyncAction } from "./drafts-sync";

const keyFor = (id: string) => `session:${id}`;

function actions(
  server: Record<string, string>,
  local: Record<string, string>,
  synced: Record<string, string>,
): DraftSyncAction[] {
  const remote: Record<string, { text: string }> = {};
  for (const [id, text] of Object.entries(server)) remote[id] = { text };
  return reconcileDrafts(remote, { local, synced }, keyFor);
}

describe("draft reconciliation", () => {
  test("a draft typed on another device lands here", () => {
    expect(actions({ "os-1": "from the phone" }, {}, {})).toEqual([
      { kind: "adopt", key: "session:os-1", text: "from the phone" },
    ]);
  });

  test("text typed here is never replaced by the server's copy", () => {
    expect(
      actions(
        { "os-1": "older, from the phone" },
        { "session:os-1": "typing right now" },
        {},
      ),
    ).toEqual([{ kind: "push", key: "session:os-1" }]);
  });

  // The case a "server wins only when local is empty" rule gets wrong: after
  // sending on the phone, the browser would keep showing the pencil forever.
  test("a draft sent elsewhere is cleared here", () => {
    expect(
      actions(
        {},
        { "session:os-1": "sent from the phone" },
        { "session:os-1": "sent from the phone" },
      ),
    ).toEqual([{ kind: "adopt", key: "session:os-1", text: "" }]);
  });

  test("a draft edited here survives the other device clearing it", () => {
    expect(
      actions(
        {},
        { "session:os-1": "kept writing" },
        { "session:os-1": "old text" },
      ),
    ).toEqual([{ kind: "push", key: "session:os-1" }]);
  });

  test("an unchanged draft is only recorded as agreed", () => {
    expect(
      actions(
        { "os-1": "same" },
        { "session:os-1": "same" },
        { "session:os-1": "same" },
      ),
    ).toEqual([{ kind: "agree", key: "session:os-1", text: "same" }]);
  });

  test("an edit made before the first load is published, not lost", () => {
    expect(actions({}, { "session:os-1": "typed while offline" }, {})).toEqual([
      { kind: "push", key: "session:os-1" },
    ]);
  });

  test("sessions are independent", () => {
    const result = actions(
      { "os-1": "remote", "os-2": "also remote" },
      { "session:os-2": "local edit" },
      {},
    );
    expect(result).toContainEqual({
      kind: "adopt",
      key: "session:os-1",
      text: "remote",
    });
    expect(result).toContainEqual({ kind: "push", key: "session:os-2" });
  });

  test("nothing to do when both sides are empty", () => {
    expect(actions({}, {}, {})).toEqual([]);
  });
});
