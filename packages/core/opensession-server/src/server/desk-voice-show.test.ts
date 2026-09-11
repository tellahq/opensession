import { describe, expect, test } from "bun:test";
import {
  SHOW_IN_APP_TOOL,
  resolveShowTarget,
  showInApp,
} from "./desk-voice-show";
import { buildLiveSessionConfig } from "./desk-voice-live";
import { registerSessionControl, type SessionControl } from "./session-control";
import type { Workspace } from "./workspaces";
import { DeskVoiceNavigation } from "./desk-voice-navigation";
import { buildVoiceSessionConfig } from "./desk-voice";

type Summary = ReturnType<SessionControl["listSessions"]>[number];

function summary(
  id: string,
  title: string,
  extra: Partial<Summary> = {},
): Summary {
  return {
    id,
    title,
    state: "idle",
    queuedCount: 0,
    controllable: true,
    createdBy: "Michiel",
    createdAt: "2026-09-10T09:00:00.000Z",
    lastActivity: "2026-09-10T10:00:00.000Z",
    ...extra,
  } as Summary;
}

const sessions: Summary[] = [
  summary("s-deploy", "Fix the deploy watchdog"),
  summary("s-deploy-old", "Fix the deploy watchdog", {
    lastActivity: "2026-09-01T10:00:00.000Z",
  }),
  summary("s-captions", "Voice captions for the Desk"),
  summary("s-lint", "Vendor lint rules"),
  summary("s-desk", "Desk", { desk: true }),
  summary("s-archived", "Archived captions work", { state: "archived" }),
  // A primary session and the two derivatives the app opens from its PR: the
  // headless review (same workspace, automation-owned) and the auto-fix worker
  // (parented on it).
  summary("s-subtitles", "Profile Subtitles sidebar opening", {
    workspaceId: "ws-subtitles",
    lastActivity: "2026-09-08T10:00:00.000Z",
  }),
  summary(
    "s-subtitles-review",
    "Review · PR #41 Profile Subtitles sidebar opening",
    {
      workspaceId: "ws-subtitles",
      automation: "github-pr-review",
      lastActivity: "2026-09-09T10:00:00.000Z",
    },
  ),
  summary("s-subtitles-fix", "Fix PR 41 feedback and CI", {
    workspaceId: "ws-subtitles",
    parentSessionId: "s-subtitles",
    agentStarted: true,
    lastActivity: "2026-09-10T11:00:00.000Z",
  }),
];

const workspaces: Workspace[] = [
  {
    id: "ws-1",
    name: "Deploy reliability",
    createdBy: "Michiel",
    createdAt: "2026-09-01T09:00:00.000Z",
  },
  {
    id: "ws-2",
    name: "Desk voice",
    createdBy: "Michiel",
    createdAt: "2026-09-02T09:00:00.000Z",
  },
];

function control(): Pick<SessionControl, "listSessions" | "getSession"> {
  return {
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id),
  };
}

const deps = {
  control: control(),
  listWorkspaces: async () => workspaces,
  getWorkspace: async (id: string) =>
    workspaces.find((w) => w.id === id) ?? null,
};

describe("show_in_app target resolution", () => {
  test("takes a session id directly", async () => {
    expect(await resolveShowTarget({ session: "s-lint" }, deps)).toEqual({
      target: { kind: "session", id: "s-lint", title: "Vendor lint rules" },
    });
  });

  test("asks which one even when duplicate titles match exactly", async () => {
    expect(
      await resolveShowTarget({ session: "fix the deploy watchdog" }, deps),
    ).toMatchObject({
      error: expect.stringContaining("Several"),
      candidates: [
        { id: "s-deploy", title: "Fix the deploy watchdog" },
        { id: "s-deploy-old", title: "Fix the deploy watchdog" },
      ],
    });
  });

  test("accepts a distinctive part of a title", async () => {
    expect(await resolveShowTarget({ session: "lint" }, deps)).toEqual({
      target: { kind: "session", id: "s-lint", title: "Vendor lint rules" },
    });
  });

  test("asks back with candidates when a part matches several", async () => {
    const result = await resolveShowTarget({ session: "deploy" }, deps);
    expect(result).toMatchObject({ error: expect.stringContaining("Several") });
    expect("candidates" in result && result.candidates).toEqual([
      { id: "s-deploy", title: "Fix the deploy watchdog" },
      { id: "s-deploy-old", title: "Fix the deploy watchdog" },
    ]);
  });

  test("never lands on the Desk or on archived sessions by title", async () => {
    expect(await resolveShowTarget({ session: "s-desk" }, deps)).toMatchObject({
      error: expect.stringContaining("No session"),
    });
    // "captions" would be ambiguous if the archived session counted.
    expect(await resolveShowTarget({ session: "captions" }, deps)).toEqual({
      target: {
        kind: "session",
        id: "s-captions",
        title: "Voice captions for the Desk",
      },
    });
  });

  test("tolerates a spoken near-miss of the title", async () => {
    // Singular/plural and a different case: the real miss that motivated this.
    expect(
      await resolveShowTarget(
        { session: "Profile subtitle sidebar opening" },
        deps,
      ),
    ).toEqual({
      target: {
        kind: "session",
        id: "s-subtitles",
        title: "Profile Subtitles sidebar opening",
      },
    });
    // Filler a voice request carries and a typo in a longer word.
    expect(
      await resolveShowTarget(
        { session: "the profile subtitels sidebar session" },
        deps,
      ),
    ).toMatchObject({ target: { id: "s-subtitles" } });
    // Terms that land nowhere are still a miss, not a guess.
    expect(
      await resolveShowTarget({ session: "profile billing export" }, deps),
    ).toMatchObject({ error: expect.stringContaining("No session") });
  });

  test("prefers a primary session over its own review and fix sessions", async () => {
    // Both the primary and its review carry these words; without the
    // derivative rule this is a flat two-item list and another round trip.
    expect(
      await resolveShowTarget({ session: "subtitles sidebar" }, deps),
    ).toEqual({
      target: {
        kind: "session",
        id: "s-subtitles",
        title: "Profile Subtitles sidebar opening",
      },
    });
    // Phrasing that singles the derivative out still reaches it.
    expect(
      await resolveShowTarget(
        { session: "the review of profile subtitles" },
        deps,
      ),
    ).toMatchObject({
      target: { id: "s-subtitles-review" },
    });
    expect(
      await resolveShowTarget({ session: "pr 41 feedback" }, deps),
    ).toMatchObject({ target: { id: "s-subtitles-fix" } });
  });

  test("carries a requested tab through to the target", async () => {
    expect(
      await resolveShowTarget({ session: "lint", tab: "review" }, deps),
    ).toEqual({
      target: {
        kind: "session",
        id: "s-lint",
        title: "Vendor lint rules",
        tab: "review",
      },
    });
    expect(
      await resolveShowTarget({ workspace: "ws-2", tab: "conversation" }, deps),
    ).toEqual({
      target: {
        kind: "workspace",
        id: "ws-2",
        name: "Desk voice",
        tab: "conversation",
      },
    });
    expect(
      await resolveShowTarget({ session: "lint", tab: "terminal" }, deps),
    ).toMatchObject({ error: expect.stringContaining("Unknown tab") });
  });

  test("resolves a workspace by id or name", async () => {
    expect(await resolveShowTarget({ workspace: "ws-2" }, deps)).toEqual({
      target: { kind: "workspace", id: "ws-2", name: "Desk voice" },
    });
    expect(
      await resolveShowTarget({ workspace: "deploy reliability" }, deps),
    ).toEqual({
      target: { kind: "workspace", id: "ws-1", name: "Deploy reliability" },
    });
  });

  test("refuses an empty request and non-string arguments", async () => {
    expect(await resolveShowTarget({}, deps)).toMatchObject({
      error: expect.stringContaining("exactly one"),
    });
    expect(
      await resolveShowTarget({ session: { id: "s-lint" } }, deps),
    ).toMatchObject({ error: expect.any(String) });
  });
});

describe("show_in_app authorization and delivery", () => {
  function registerStubControl() {
    registerSessionControl({
      ...control(),
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({
        status: "error" as const,
        message: "not used",
      }),
      cancelSession: () => false,
      reparentSession: async () => ({ ok: false, error: "not used" }),
      createSession: async () => ({
        id: "unused",
        createdBy: "Test",
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
    });
  }

  test("fails closed without a verified call capability", async () => {
    expect(await showInApp(undefined, { session: "lint" })).toMatchObject({
      shown: false,
    });
  });

  test("returns success only after the owning browser acknowledges", async () => {
    registerStubControl();
    const nav = new DeskVoiceNavigation("signed-in-login");
    const pending = showInApp(nav, { session: "lint", tab: "review" });
    await Promise.resolve();
    const polled = nav.handle("signed-in-login", {
      action: "poll",
      connectionId: "call",
      token: nav.token,
    });
    if (!polled || !("command" in polled) || !polled.command)
      throw new Error("missing command");
    expect(polled.command.target).toEqual({
      kind: "session",
      id: "s-lint",
      tab: "review",
    });
    nav.handle("signed-in-login", {
      action: "ack",
      connectionId: "call",
      token: nav.token,
      commandId: polled.command.id,
      shown: true,
    });
    expect(await pending).toEqual({
      shown: true,
      kind: "session",
      id: "s-lint",
      title: "Vendor lint rules",
      tab: "review",
    });
    nav.close();
  });

  test("rejects multiple targets, extra navigation parameters and oversized names", async () => {
    for (const args of [
      { session: "lint", workspace: "ws-1" },
      { session: "lint", url: "https://example.invalid" },
      { workspace: "x".repeat(257) },
    ]) {
      expect(await resolveShowTarget(args, deps)).toMatchObject({
        error: expect.any(String),
      });
    }
  });

  test("is advertised only to a capable web voice backend, never native", async () => {
    registerStubControl();
    const enabled = await buildLiveSessionConfig(
      "missing-test-session",
      "Test",
      true,
    );
    const disabled = await buildLiveSessionConfig("missing-test-session");
    const native = await buildVoiceSessionConfig("missing-test-session");
    expect(
      enabled.delegation.responses.tools.some(
        (t) => t.name === SHOW_IN_APP_TOOL.name,
      ),
    ).toBe(true);
    expect(
      disabled.delegation.responses.tools.some(
        (t) => t.name === SHOW_IN_APP_TOOL.name,
      ),
    ).toBe(false);
    expect(native.tools.some((t) => t.name === SHOW_IN_APP_TOOL.name)).toBe(
      false,
    );
  });
});
