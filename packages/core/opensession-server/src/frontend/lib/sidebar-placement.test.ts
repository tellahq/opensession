import { describe, expect, test } from "bun:test";
import { AGENT_PERSON_KEY } from "./automation-audience";
import type { UnifiedSession } from "./types";
import type { WsRow } from "./sidebar-types";
import {
  classifySidebarPlacement,
  placeSidebarRows,
  rowAutoCreatedInLens,
  rowWasAgentStarted,
  rowWasAutoCreated,
  rowsAtPlacement,
  sessionWasAgentStarted,
  sessionWasAutoCreated,
  type SidebarPlacement,
} from "./sidebar-placement";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    startedBy: "Michiel",
    isRunning: false,
    ...overrides,
  } as UnifiedSession;
}

function row(
  key: string,
  sessions: UnifiedSession[],
  overrides: Partial<WsRow> = {},
): WsRow {
  return {
    key,
    workspace: null,
    name: key,
    sessions,
    status: "pending",
    lastActivity: "2026-08-16T00:00:00Z",
    createdAt: "2026-08-16T00:00:00Z",
    unread: false,
    running: false,
    owner: "michiel",
    ...overrides,
  };
}

const context = {
  currentUser: "Michiel",
  personFilter: "me",
  snoozed: false,
  inStatusScope: true,
};

describe("sidebar row placement", () => {
  test("assigns every row to exactly one primary band", () => {
    const rows = [
      row(
        "snoozed",
        [
          session("snoozed", {
            startedBy: "Kent",
            reviewRequest: {
              to: "Michiel",
              by: "Kent",
              at: "2026-08-16T00:00:00Z",
            },
          }),
        ],
        { owner: "kent" },
      ),
      row(
        "needs",
        [
          session("needs", {
            startedBy: "Kent",
            reviewRequest: {
              to: "Michiel",
              by: "Kent",
              at: "2026-08-16T00:00:00Z",
            },
          }),
        ],
        { owner: "kent" },
      ),
      row("approved", [
        session("approved", {
          reviewRequest: {
            to: "Kent",
            by: "Michiel",
            at: "2026-08-16T00:00:00Z",
          },
          prReviewDecision: "APPROVED",
        }),
      ]),
      row("awaiting", [
        session("awaiting", {
          reviewRequest: {
            to: "Kent",
            by: "Michiel",
            at: "2026-08-16T00:00:00Z",
          },
        }),
      ]),
      row(
        "completed",
        [
          session("completed", {
            startedBy: "Kent",
            reviewRequest: {
              to: "Michiel",
              by: "Kent",
              at: "2026-08-16T00:00:00Z",
              accepted: {
                by: "Michiel",
                at: "2026-08-16T01:00:00Z",
              },
            },
          }),
        ],
        { owner: "kent" },
      ),
      row("status", [session("status")]),
      row("outside", [session("outside")], { owner: "kent" }),
    ];
    const placed = placeSidebarRows(rows, (candidate) => ({
      ...context,
      snoozed: candidate.key === "snoozed",
      inStatusScope: candidate.key !== "outside",
    }));
    const placements: SidebarPlacement[] = [
      "snoozed",
      "needs-review",
      "approved-review",
      "awaiting-review",
      "completed-review",
      "status",
      "outside",
    ];
    const keys = placements.flatMap((placement) =>
      rowsAtPlacement(placed, placement).map((candidate) => candidate.key),
    );

    expect(
      Object.fromEntries(
        placed.map((entry) => [entry.row.key, entry.placement]),
      ),
    ).toEqual({
      snoozed: "snoozed",
      needs: "needs-review",
      approved: "approved-review",
      awaiting: "awaiting-review",
      completed: "completed-review",
      status: "status",
      outside: "outside",
    });
    expect(keys.sort()).toEqual(rows.map((candidate) => candidate.key).sort());
    expect(new Set(keys).size).toBe(rows.length);
  });

  test("keeps an outstanding GitHub request ahead of another approval", () => {
    const candidate = row(
      "requested-and-approved",
      [
        session("requested-and-approved", {
          startedBy: "Kent",
          prReviewRequested: ["michiel"],
          prReviewDecision: "APPROVED",
          reviewRequest: {
            to: "Kent",
            by: "Michiel",
            at: "2026-08-16T00:00:00Z",
          },
        }),
      ],
      { owner: "kent" },
    );

    expect(classifySidebarPlacement(candidate, context)).toBe("needs-review");
  });

  test("puts a personally kept review workspace in Active", () => {
    const candidate = row(
      "kept-review",
      [
        session("kept-review", {
          startedBy: "Johnny",
          prReviewRequested: ["michiel"],
        }),
      ],
      { owner: "johnny" },
    );

    expect(classifySidebarPlacement(candidate, context)).toBe("needs-review");
    expect(
      classifySidebarPlacement(candidate, { ...context, claimed: true }),
    ).toBe("status");
    expect(
      classifySidebarPlacement(candidate, {
        ...context,
        claimed: true,
        snoozed: true,
      }),
    ).toBe("snoozed");
  });

  test("preserves source order within each placement", () => {
    const rows = ["newest", "middle", "oldest"].map((key) =>
      row(key, [session(key)]),
    );
    const placed = placeSidebarRows(rows, () => context);

    expect(
      rowsAtPlacement(placed, "status").map((candidate) => candidate.key),
    ).toEqual(["newest", "middle", "oldest"]);
  });

  // Machine-started work has no band of its own: it lands in the agent's
  // ordinary lanes wearing a robot rather than appearing as every teammate's.
  test("files ordinary machine-created work under the agent", () => {
    const candidate = row(
      "native-parity",
      [
        session("native-parity", {
          createdBy: "Automation",
          startedBy: "Automation",
        }),
      ],
      { owner: "automation" },
    );

    expect(classifySidebarPlacement(candidate, context)).toBe("status");
    expect(rowAutoCreatedInLens(candidate, "me")).toBe(false);
    expect(rowAutoCreatedInLens(candidate, "kent")).toBe(false);
    expect(rowAutoCreatedInLens(candidate, AGENT_PERSON_KEY)).toBe(true);
    // Out of scope is what the caller's hide filter produces.
    expect(
      classifySidebarPlacement(candidate, { ...context, inStatusScope: false }),
    ).toBe("outside");
  });

  // A review being asked of you outranks the hide filter: the caller drops a
  // hidden row out of status scope, and this row still lands in Needs review.
  test("keeps a review request on a machine-created row out of scope's reach", () => {
    const candidate = row(
      "native-parity",
      [
        session("native-parity", {
          createdBy: "Automation",
          startedBy: "Automation",
          reviewRequest: {
            to: "Michiel",
            by: "Automation",
            at: "2026-08-16T00:00:00Z",
          },
        }),
      ],
      { owner: "automation" },
    );

    expect(
      classifySidebarPlacement(candidate, { ...context, inStatusScope: false }),
    ).toBe("needs-review");
  });

  test("renders machine-created rows once under aggregate and machine lenses", () => {
    const candidate = row(
      "native-parity",
      [
        session("native-parity", {
          createdBy: "Automation",
          startedBy: "Automation",
        }),
      ],
      { owner: "automation" },
    );

    expect(
      classifySidebarPlacement(candidate, {
        ...context,
        personFilter: "everyone",
      }),
    ).toBe("status");
    expect(
      classifySidebarPlacement(candidate, {
        ...context,
        personFilter: "automation",
      }),
    ).toBe("status");
  });

  test("marks every non-composer origin as agent-started", () => {
    expect(
      sessionWasAgentStarted(session("report", { agentStarted: true })),
    ).toBe(true);
    expect(
      sessionWasAgentStarted(
        session("legacy-report", { branch: "report-fix-ios" }),
      ),
    ).toBe(true);
    expect(
      sessionWasAgentStarted(session("child", { parentSessionId: "parent" })),
    ).toBe(true);
    expect(sessionWasAgentStarted(session("mine"))).toBe(false);

    const reportRow = row("report", [
      session("report", { agentStarted: true }),
    ]);
    expect(rowWasAgentStarted(reportRow)).toBe(true);
  });

  test("never treats automation runs as auto-created work", () => {
    const run = row(
      "automation-run",
      [
        session("automation-run", {
          createdBy: "Automation",
          startedBy: "Automation",
          automation: "iOS parity check",
        }),
      ],
      {
        owner: "automation",
        workspace: {
          id: "ws-automation",
          name: "Automation run",
          createdBy: "Automation",
          createdAt: "2026-08-16T00:00:00Z",
        },
      },
    );

    expect(rowWasAutoCreated(run)).toBe(false);
    expect(classifySidebarPlacement(run, context)).toBe("status");
  });

  test("recognizes a sessionless workspace created by the machine", () => {
    const draft = row("draft", [], {
      owner: "automation",
      workspace: {
        id: "ws-draft",
        name: "Draft",
        createdBy: "Automation",
        createdAt: "2026-08-16T00:00:00Z",
      },
    });

    expect(rowWasAutoCreated(draft)).toBe(true);
    expect(rowAutoCreatedInLens(draft, "me")).toBe(false);
    expect(rowAutoCreatedInLens(draft, AGENT_PERSON_KEY)).toBe(true);
    expect(classifySidebarPlacement(draft, context)).toBe("status");
  });

  // The row mark and the filter read one fact, so what a row says about
  // itself and what the filter removes cannot drift apart.
  test("marks a session the machine identity created", () => {
    expect(
      sessionWasAutoCreated(session("auto", { createdBy: "Automation" })),
    ).toBe(true);
    expect(
      sessionWasAutoCreated(
        session("auto-started", { startedBy: " automation " }),
      ),
    ).toBe(true);
    expect(sessionWasAutoCreated(session("mine"))).toBe(false);
    expect(
      sessionWasAutoCreated(session("theirs", { createdBy: "Kent" })),
    ).toBe(false);
  });

  test("does not classify a mixed human and machine workspace as auto-created", () => {
    const mixed = row(
      "shared-work",
      [
        session("probe", { createdBy: "Automation" }),
        session("follow-up", { createdBy: "Kent", startedBy: "Kent" }),
      ],
      { owner: "automation" },
    );

    expect(rowWasAutoCreated(mixed)).toBe(false);
    expect(rowAutoCreatedInLens(mixed, "me")).toBe(false);
  });
});
