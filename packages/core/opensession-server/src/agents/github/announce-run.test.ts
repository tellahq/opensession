/**
 * A PR behavior publishes its run's session link (the "📺 open session" comment,
 * the info panel's "open run") before the engine exists, so the session file has
 * to exist by then too. Without announceGithubRun, following that link during
 * the PR-fetch + worktree-checkout window landed on "Session not found".
 *
 * What can silently regress is the merge: the announce must not flatten a
 * resumable run's engine ids on its second round.
 */
import { expect, test } from "bun:test";
import {
  announcedSessionFile,
  bksIdFor,
  recoverableGithubRun,
  type AnnouncedRun,
} from "./run";
import type { ActiveRunRecord } from "../../server/run-journal";
import type { NativeSessionFile } from "../../server/types";

const run: AnnouncedRun = {
  prNumber: 4242,
  kind: "simplify",
  branch: "some-branch",
  title: "Simplify · PR #4242 Something",
  mode: "code",
};

test("a first announce fills in everything the sessions list reads", () => {
  const id = bksIdFor(run.prNumber, run.kind);
  const file = announcedSessionFile(
    {} as NativeSessionFile,
    id,
    run,
    "ws-1",
    "app",
  );

  expect(file).toMatchObject({
    id,
    title: "Simplify · PR #4242 Something",
    branch: "some-branch",
    mode: "code",
    repo: "app",
    automation: "github-pr-review",
    workspaceId: "ws-1",
  });
  // No worktree yet: that checkout is what the announce gets ahead of.
  expect(file.worktreeDir).toBe("");
  expect(file.createdAt).toBeTruthy();
});

test("a later round keeps the engine session and the original createdAt", () => {
  const id = bksIdFor(4243, "autofix");
  const existing = {
    id,
    claudeSessionId: "ses_existing",
    worktreeDir: "/tmp/some-worktree",
    createdAt: "2020-01-01T00:00:00.000Z",
    model: "some-model",
    title: "Auto-fix · PR #4243 Old title",
    branch: "some-branch",
    mode: "code",
  } as NativeSessionFile;

  const file = announcedSessionFile(
    existing,
    id,
    {
      ...run,
      prNumber: 4243,
      kind: "autofix",
      title: "Auto-fix · PR #4243 New",
    },
    null,
    "app",
  );

  expect(file).toMatchObject({
    claudeSessionId: "ses_existing",
    worktreeDir: "/tmp/some-worktree",
    createdAt: "2020-01-01T00:00:00.000Z",
    model: "some-model",
    title: "Auto-fix · PR #4243 New",
  });
  // No workspace resolved this round: don't write an empty one over the file.
  expect("workspaceId" in file).toBe(false);
});

test("restart recovery selects only the newest detached turn for this behavior", () => {
  const id = bksIdFor(4244, "review");
  const record = (
    runKey: string,
    patch: Partial<ActiveRunRecord> = {},
  ): ActiveRunRecord => ({
    runKey,
    hostId: runKey,
    osSessionId: id,
    cwd: "/tmp/review",
    kind: "github-review",
    startedAt: "2026-08-20T10:00:00.000Z",
    ...patch,
  });
  const newest = record("rh-new", {
    startedAt: "2026-08-20T10:01:00.000Z",
  });

  expect(
    recoverableGithubRun(
      [
        record("rh-old"),
        record("rh-in-process", { hostId: undefined }),
        record("rh-other-kind", { kind: "github-simplify" }),
        record("rh-other-session", { osSessionId: "bks-other" }),
        newest,
      ],
      id,
      "review",
    ),
  ).toEqual(newest);
});
