import { describe, expect, it } from "bun:test";
import {
  familyRoot,
  foldContext,
  foldFamilies,
  parentLinks,
  type Foldable,
} from "./session-family";

const DAY = 86_400_000;
const T0 = 1_770_000_000_000;

const hit = (id: string, ts = T0): Foldable & { score: number } => ({
  id: `session:${id}`,
  ts,
  score: 1,
});

describe("parentLinks", () => {
  it("links workers to their parent and helpers to their spawner", () => {
    const parents = parentLinks([
      { id: "a" },
      { id: "b", parentSessionId: "a" },
      { id: "c", spawnedBy: "a" },
    ]);
    expect(parents.get("b")).toBe("a");
    expect(parents.get("c")).toBe("a");
    expect(parents.has("a")).toBe(false);
  });

  it("ignores a session that claims itself as parent", () => {
    expect(parentLinks([{ id: "a", parentSessionId: "a" }]).size).toBe(0);
  });
});

describe("familyRoot", () => {
  it("walks a chain to its oldest ancestor", () => {
    const parents = parentLinks([
      { id: "b", parentSessionId: "a" },
      { id: "c", parentSessionId: "b" },
    ]);
    expect(familyRoot("c", parents)).toBe("a");
    expect(familyRoot("a", parents)).toBe("a");
  });

  it("returns a parent that is not itself in the list", () => {
    const parents = parentLinks([{ id: "b", parentSessionId: "gone" }]);
    expect(familyRoot("b", parents)).toBe("gone");
  });

  it("survives a cycle", () => {
    const parents = parentLinks([
      { id: "a", parentSessionId: "b" },
      { id: "b", parentSessionId: "a" },
    ]);
    expect(["a", "b"]).toContain(familyRoot("a", parents));
  });
});

describe("foldFamilies", () => {
  // The real shape: a code session, the review spawned from it, and a
  // follow-up the human started later: all one workspace, one piece of work.
  const ctx = foldContext([
    { id: "work", workspaceId: "ws-1" },
    { id: "review", parentSessionId: "work", workspaceId: "ws-1" },
    { id: "followup", workspaceId: "ws-1" },
    { id: "other", workspaceId: "ws-2" },
  ]);

  it("keeps a session and its review as one hit", () => {
    const out = foldFamilies([hit("work"), hit("review")], ctx, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work"]);
    expect(out[0]!.workspaceId).toBe("ws-1");
    expect(out[0]!.folded?.map((h) => h.id)).toEqual(["session:review"]);
  });

  it("folds a human's sibling sessions in the same workspace", () => {
    const out = foldFamilies([hit("work"), hit("followup")], ctx, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work"]);
    expect(out[0]!.folded?.map((h) => h.id)).toEqual(["session:followup"]);
  });

  it("lets the best-scoring member lead, and names its parent", () => {
    const out = foldFamilies([hit("review"), hit("work")], ctx, 8);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("session:review");
    expect(out[0]!.parentId).toBe("work");
  });

  it("keeps a spawn separate once its workspace holds work of its own", () => {
    const aside = foldContext([
      { id: "work", workspaceId: "ws-1" },
      { id: "aside", parentSessionId: "work", workspaceId: "ws-9" },
      { id: "aside-followup", workspaceId: "ws-9" },
    ]);
    const out = foldFamilies([hit("work"), hit("aside")], aside, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work", "session:aside"]);
  });

  it("folds a spawn that sits alone in a workspace of its own", () => {
    // A fifth of spawned sessions mint a workspace instead of joining the
    // parent's. Alone in it, that workspace is spawn bookkeeping, not work.
    const minted = foldContext([
      { id: "work", workspaceId: "ws-1" },
      { id: "review", parentSessionId: "work", workspaceId: "ws-9" },
    ]);
    const out = foldFamilies([hit("work"), hit("review")], minted, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work"]);
    expect(out[0]!.folded?.map((h) => h.id)).toEqual(["session:review"]);
  });

  it("falls back to the parent chain when neither session has a workspace", () => {
    const legacy = foldContext([
      { id: "work" },
      { id: "review", parentSessionId: "work" },
    ]);
    const out = foldFamilies([hit("work"), hit("review")], legacy, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work"]);
  });

  it("adopts the parent's workspace for a child that has none", () => {
    const mixed = foldContext([
      { id: "work", workspaceId: "ws-1" },
      { id: "review", parentSessionId: "work" },
    ]);
    const out = foldFamilies([hit("work"), hit("review")], mixed, 8);
    expect(out.map((h) => h.id)).toEqual(["session:work"]);
    expect(out[0]!.workspaceId).toBe("ws-1");
  });

  it("does not fold sessions a year apart in a long-lived feed workspace", () => {
    const out = foldFamilies(
      [hit("work"), hit("followup", T0 + 365 * DAY)],
      ctx,
      8,
    );
    expect(out).toHaveLength(2);
  });

  it("leaves unrelated workspaces alone and applies the limit after folding", () => {
    const out = foldFamilies(
      [hit("work"), hit("review"), hit("other"), hit("loose")],
      ctx,
      2,
    );
    expect(out.map((h) => h.id)).toEqual(["session:work", "session:other"]);
  });
});
