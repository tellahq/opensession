import { describe, expect, test } from "bun:test";
import {
  type ReparentableSession,
  validateSessionReparent,
} from "./session-parenting";

function sessions(...rows: ReparentableSession[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: string) => byId.get(id);
}

describe("validateSessionReparent", () => {
  test("allows attaching a native session to another known session", () => {
    const find = sessions(
      { id: "child", source: "opensession" },
      { id: "parent", source: "slack" },
    );
    const result = validateSessionReparent("child", "parent", find);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parent?.id).toBe("parent");
  });

  test("allows removing a native session's parent", () => {
    const find = sessions({
      id: "child",
      source: "opensession",
      parentSessionId: "parent",
    });
    const result = validateSessionReparent("child", undefined, find);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parent).toBeUndefined();
  });

  test("rejects unknown, external, self, and missing-parent changes", () => {
    const find = sessions(
      { id: "native", source: "opensession" },
      { id: "external", source: "linear" },
    );
    expect(validateSessionReparent("missing", undefined, find)).toEqual({
      ok: false,
      error: "No session with id `missing`.",
    });
    expect(validateSessionReparent("external", undefined, find)).toMatchObject({
      ok: false,
    });
    expect(validateSessionReparent("native", "native", find)).toEqual({
      ok: false,
      error: "A session cannot be its own parent.",
    });
    expect(validateSessionReparent("native", "missing", find)).toEqual({
      ok: false,
      error: "No parent session with id `missing`.",
    });
  });

  test("rejects cycles through visible parent and internal spawn links", () => {
    const find = sessions(
      { id: "root", source: "opensession" },
      { id: "child", source: "opensession", parentSessionId: "root" },
      { id: "grandchild", source: "opensession", spawnedBy: "child" },
    );
    const result = validateSessionReparent("root", "grandchild", find);
    expect(result).toEqual({
      ok: false,
      error: "Reparenting `root` to `grandchild` would create a cycle.",
    });
  });
});
