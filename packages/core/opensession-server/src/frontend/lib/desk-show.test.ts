import { describe, expect, test } from "bun:test";
import { deskShowRoute } from "./desk-show";
import { deskShowTargetSchema } from "../../shared/desk-navigation";

describe("deskShowRoute", () => {
  test("maps a session or workspace id onto its route", () => {
    expect(deskShowRoute({ kind: "session", id: "s-1" })).toEqual({
      view: "session",
      id: "s-1",
    });
    expect(deskShowRoute({ kind: "workspace", id: "ws-1" })).toEqual({
      view: "workspace",
      id: "ws-1",
    });
  });

  test("a workspace tab rides the route; a session tab is applied after landing", () => {
    expect(
      deskShowRoute({ kind: "workspace", id: "ws-1", tab: "review" }),
    ).toEqual({ view: "workspace", id: "ws-1", tab: "review" });
    // The workspace home is its session, so chat adds no pane suffix.
    expect(
      deskShowRoute({ kind: "workspace", id: "ws-1", tab: "chat" }),
    ).toEqual({ view: "workspace", id: "ws-1" });
    expect(
      deskShowRoute({ kind: "session", id: "s-1", tab: "review" }),
    ).toEqual({ view: "session", id: "s-1" });
  });

  test("the boundary drops anything outside the fixed route table", () => {
    for (const target of [
      null,
      { kind: "settings", id: "x" },
      { kind: "session", id: 5 },
      { kind: "session", id: "s-1", tab: "terminal" },
      { kind: "session", id: "s-1", tab: "/review" },
      ...[
        " ",
        "../settings",
        "https://example.invalid",
        "s-1?x=1",
        "s-1#x",
        "%2e%2e",
        "s/2",
        "",
      ].map((id) => ({ kind: "session", id })),
    ]) {
      expect(deskShowTargetSchema.safeParse(target).success).toBe(false);
    }
  });
});
