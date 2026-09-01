import { describe, expect, test } from "bun:test";
import { decideSandboxHostRecovery } from "./recovery";
import type { ActiveRunRecord } from "../run-journal";

const run = (patch: Partial<ActiveRunRecord> = {}): ActiveRunRecord => ({
  runKey: "rh-old",
  osSessionId: "os-1",
  cwd: "/workspace",
  prompt: "do it",
  startedAt: "2026-08-20T00:00:00.000Z",
  ...patch,
});

describe("sandbox host recovery decision", () => {
  test("replays a prepared existing-thread or fork spec exactly", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({ launchPhase: "prepared", claudeSessionId: "source-thread" }),
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "replay" });
  });

  test("prefers engine identity written by the host", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({ launchPhase: "started" }),
        meta: {
          hostId: "rh-old",
          pid: 42,
          osSessionId: "os-1",
          startedAt: "now",
          engineSessionId: "engine-1",
        },
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "resume", engineSessionId: "engine-1" });
  });

  test("treats an in-flight launch call as uncertain before host evidence", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({ launchPhase: "launching", claudeSessionId: "preexisting" }),
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "uncertain" });
  });

  test("does not use a preexisting target as a started-run checkpoint", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({
          launchPhase: "started",
          claudeSessionId: "source-or-thread",
        }),
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "uncertain" });
  });

  test("does not treat a copied private resume target as provider intake", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({ launchPhase: "started", claudeSessionId: "source-thread" }),
        privateRun: run({ claudeSessionId: "source-thread" }),
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "uncertain" });
  });

  test("never replays observed execution without a resumable engine", () => {
    expect(
      decideSandboxHostRecovery({
        run: run({ launchPhase: "started" }),
        meta: {
          hostId: "rh-old",
          pid: 42,
          osSessionId: "os-1",
          startedAt: "now",
        },
        hasCompleteSpec: true,
      }),
    ).toEqual({ kind: "uncertain" });
  });
});
