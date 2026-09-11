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
    const pending = showInApp(nav, { session: "lint" });
    await Promise.resolve();
    const polled = nav.handle("signed-in-login", {
      action: "poll",
      connectionId: "call",
      token: nav.token,
    });
    if (!polled || !("command" in polled) || !polled.command)
      throw new Error("missing command");
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
