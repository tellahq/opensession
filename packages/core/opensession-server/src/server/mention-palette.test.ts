import { describe, expect, test } from "bun:test";
import { mentionPaletteItems } from "./mention-palette";

describe("mentionPaletteItems", () => {
  const sessions = [
    {
      id: "current",
      title: "Current session",
      lastActivity: "2026-08-19T12:00:00Z",
    },
    {
      id: "recent",
      title: "Release follow-up",
      branch: "fix/release",
      repo: "opensession",
      lastActivity: "2026-08-19T11:00:00Z",
    },
    {
      id: "older",
      title: "Billing audit",
      branch: "audit/billing",
      lastActivity: "2026-08-18T11:00:00Z",
    },
    {
      id: "closed",
      title: "Archived",
      archived: true,
      lastActivity: "2026-08-19T13:00:00Z",
    },
  ];

  test("lists tools, workspaces, then recent active sessions for a bare trigger", () => {
    const rows = mentionPaletteItems({
      query: "",
      toolNames: ["slack", "linear", "linear"],
      workspaces: [
        { id: "ws-release", name: "Release work", repo: "opensession" },
      ],
      sessions,
      currentSessionId: "current",
    });

    expect(rows.map((row) => `${row.kind}:${row.insert}`)).toEqual([
      "tool:linear",
      "tool:slack",
      "workspace:workspace:ws-release",
      "session:session:recent",
      "session:session:older",
    ]);
  });

  test("filters tools and session metadata with the same query", () => {
    const rows = mentionPaletteItems({
      query: "bill",
      toolNames: ["slack", "billing-admin"],
      workspaces: [],
      sessions,
    });

    expect(rows).toEqual([
      {
        display: "billing-admin",
        insert: "billing-admin",
        kind: "tool",
      },
      {
        display: "Billing audit",
        insert: "session:older",
        kind: "session",
        sub: "audit/billing",
      },
    ]);
  });

  test("finds workspaces by name, repo, branch, or stable id", () => {
    const workspaces = [
      {
        id: "ws-launch",
        name: "Launch planning",
        repo: "webapp",
        branch: "launch/august",
      },
    ];
    for (const query of ["planning", "webapp", "august", "ws-launch"]) {
      expect(
        mentionPaletteItems({
          query,
          toolNames: [],
          workspaces,
          sessions: [],
        }),
      ).toEqual([
        {
          display: "Launch planning",
          insert: "workspace:ws-launch",
          kind: "workspace",
          sub: "launch/august",
        },
      ]);
    }
  });
});
