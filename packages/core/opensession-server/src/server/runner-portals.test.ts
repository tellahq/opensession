import { describe, expect, test } from "bun:test";
import {
  orphanedRunnerPortalRecords,
  type RunnerPortalRecord,
} from "./runner-portals";

const portal = (sessionId: string): RunnerPortalRecord => ({
  name: "webapp",
  key: "PORTAL_WEBAPP_PORT",
  command: "bun run dev",
  port: 4300,
  state: "awake",
  runnerId: "runner-1",
  sessionId,
  repo: "app",
  workspacePath: `/worktrees/${sessionId}`,
  user: "portal-owner",
});

describe("Runner Portal ownership", () => {
  test("only selects records whose session is gone", () => {
    expect(
      orphanedRunnerPortalRecords(
        [portal("live"), portal("deleted")],
        new Set(["live"]),
      ),
    ).toEqual([portal("deleted")]);
  });
});
