import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultRepo } from "../../server/config";
import type {
  SessionControl,
  SessionSummary,
} from "../../server/session-control";
import {
  boundedSessionNotificationIds,
  matchSessions,
  MAX_SESSION_NOTIFICATION_FANOUT,
} from "./session-notify";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function controlWith(sessions: SessionSummary[]): SessionControl {
  return { listSessions: () => sessions } as SessionControl;
}

function summary(
  input: Partial<SessionSummary> & Pick<SessionSummary, "id">,
): SessionSummary {
  return {
    state: "idle",
    repo: defaultRepo().id,
    branch: "some-other-branch",
    worktreeDir: defaultRepo().repo,
    ...input,
  } as SessionSummary;
}

describe("GitHub session notification matching", () => {
  test("does not treat a shared checkout HEAD as every session's branch", () => {
    const shared = summary({ id: "shared-session", branch: "recorded-branch" });
    expect(
      matchSessions(
        controlWith([shared]),
        defaultRepo().id,
        "shared-checkout-head",
      ),
    ).toEqual([]);
  });

  test("still follows actual HEAD for an isolated worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-notify-worktree-"));
    scratch.push(dir);
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, ".git", "HEAD"),
      "ref: refs/heads/renamed-by-agent\n",
    );
    const isolated = summary({ id: "isolated-session", worktreeDir: dir });
    expect(
      matchSessions(
        controlWith([isolated]),
        defaultRepo().id,
        "renamed-by-agent",
      ),
    ).toEqual([isolated]);
  });

  test("deduplicates normal matches and refuses an implausible fan-out", () => {
    expect(boundedSessionNotificationIds(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(
      boundedSessionNotificationIds(
        Array.from(
          { length: MAX_SESSION_NOTIFICATION_FANOUT + 1 },
          (_, i) => `session-${i}`,
        ),
      ),
    ).toBeNull();
  });
});
