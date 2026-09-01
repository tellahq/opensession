import { describe, expect, it } from "bun:test";
import {
  collectHandoffEvidence,
  commandHead,
  evidenceFromTranscript,
  formatHandoffEvidence,
  notifyParentOfFailedRun,
  type BeaconDeps,
  type EvidenceDeps,
  type HandoffEvidence,
} from "./handoff-evidence";
import type { TranscriptEntry, UnifiedSession } from "./types";

function call(id: string, toolName: string, input: unknown): TranscriptEntry {
  return {
    id,
    type: "tool_use",
    content: `Using ${toolName}`,
    timestamp: "2026-07-24T10:00:00Z",
    toolName,
    toolUseId: id,
    toolInput: input,
  };
}

function result(
  forId: string,
  content: string,
  isError = false,
): TranscriptEntry {
  return {
    id: `${forId}-r`,
    type: "tool_result",
    content,
    timestamp: "2026-07-24T10:00:01Z",
    toolUseId: forId,
    ...(isError ? { isError: true } : {}),
  };
}

describe("commandHead", () => {
  it("drops cd preambles and keeps program + first argument", () => {
    expect(
      commandHead("cd /home/ubuntu/projects/x && bun test src/server"),
    ).toBe("bun test");
    expect(commandHead("git status --short | head -30")).toBe("git status");
    expect(commandHead("  ls   -la  ")).toBe("ls -la");
  });
});

describe("evidenceFromTranscript", () => {
  it("pairs an errored result with the call that produced it", () => {
    const { failures } = evidenceFromTranscript([
      call("t1", "edit", { filePath: "src/server/x.ts" }),
      result("t1", "Error: Could not find oldString in the file.", true),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      tool: "edit",
      what: "src/server/x.ts",
      laterPassed: false,
    });
    expect(failures[0]!.errorTail).toContain("Could not find oldString");
  });

  it("keeps a failed attempt even after a later one succeeded, and says so", () => {
    const { failures } = evidenceFromTranscript([
      call("t1", "edit", { filePath: "src/a.ts" }),
      result("t1", "Error: no match", true),
      call("t2", "edit", { filePath: "src/a.ts" }),
      result("t2", "ok"),
    ]);
    // The dead end is the point — it survives instead of being summarized away.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.laterPassed).toBe(true);
  });

  it("collapses repeats of the same failure", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 4; i++) {
      entries.push(call(`t${i}`, "bash", { command: "bun run typecheck" }));
      entries.push(result(`t${i}`, "tsc exploded", true));
    }
    const { failures } = evidenceFromTranscript(entries);
    expect(failures).toHaveLength(1);
  });

  it("keeps both ends of a huge error — what failed, and the verdict", () => {
    // Seen live: an pi permission denial names the tool up front and
    // then dumps the whole permission config, so a tail-only clip showed
    // nothing but config. A test runner is the opposite shape.
    const { failures } = evidenceFromTranscript([
      call("t1", "bash", { command: "bun test" }),
      result(
        "t1",
        `Permission denied for /tmp${" config ".repeat(500)}FAILED at the very end`,
        true,
      ),
    ]);
    expect(failures[0]!.errorTail).toContain("Permission denied for /tmp");
    expect(failures[0]!.errorTail).toContain("FAILED at the very end");
    expect(failures[0]!.errorTail).toContain("…");
    expect(failures[0]!.errorTail.length).toBeLessThan(700);
  });

  it("lists distinct bash command heads and ignores non-bash tools", () => {
    const { commands } = evidenceFromTranscript([
      call("t1", "bash", { command: "cd /repo && bun test src/a" }),
      result("t1", "ok"),
      call("t2", "bash", { command: "cd /repo && bun test src/b" }),
      result("t2", "ok"),
      call("t3", "bash", { command: "git push" }),
      result("t3", "ok"),
      call("t4", "read", { filePath: "src/a.ts" }),
      result("t4", "contents"),
    ]);
    expect(commands).toEqual(["bun test", "git push"]);
  });

  it("makes no pass/fail claim about commands the tool did not flag", () => {
    // pi does not set isError on a non-zero shell exit, so a command
    // whose output merely mentions an error must NOT be reported as failed.
    const { failures, commands } = evidenceFromTranscript([
      call("t1", "bash", { command: "grep -r error src/" }),
      result("t1", "src/a.ts: error handling here"),
    ]);
    expect(failures).toHaveLength(0);
    expect(commands).toEqual(["grep -r"]);
  });
});

function session(over: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "bks-child",
    mode: "code",
    worktreeDir: "/wt/child",
    repo: "opensession",
    branch: "feat/x",
    isRunning: false,
    ...over,
  } as UnifiedSession;
}

function evidenceDeps(over: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    getSession: (id) => (id === "bks-child" ? session() : null),
    transcript: async () => [],
    diff: async () => ({
      files: [
        { path: "src/a.ts", status: "modified", additions: 10, deletions: 2 },
      ],
      totalAdditions: 10,
      totalDeletions: 2,
    }),
    defaultBranch: () => "master",
    isSharedCheckout: () => false,
    exists: () => true,
    ...over,
  };
}

describe("collectHandoffEvidence", () => {
  it("gathers diff, PR, usage and failures for a finished worker", async () => {
    const ev = await collectHandoffEvidence(
      "bks-child",
      evidenceDeps({
        getSession: () =>
          session({
            prUrl: "https://github.com/x/y/pull/1",
            prState: "OPEN",
            usage: { turns: 3, costUsd: 0.42 } as never,
          }),
        transcript: async () => [
          call("t1", "bash", { command: "bun test" }),
          result("t1", "boom", true),
        ],
      }),
    );
    expect(ev).toBeTruthy();
    expect(ev!.state).toBe("done");
    expect(ev!.pr).toEqual({
      url: "https://github.com/x/y/pull/1",
      state: "OPEN",
    });
    expect(ev!.usage).toEqual({ turns: 3, costUsd: 0.42 });
    expect(ev!.diff!.files[0]!.path).toBe("src/a.ts");
    expect(ev!.diff!.shared).toBe(false);
    expect(ev!.failures).toHaveLength(1);
  });

  it("flags a diff taken in a worktree shared with the parent", async () => {
    const ev = await collectHandoffEvidence(
      "bks-child",
      evidenceDeps({
        getSession: (id) =>
          id === "bks-child"
            ? session({ parentSessionId: "bks-parent" })
            : session({ id: "bks-parent", worktreeDir: "/wt/child" }),
      }),
    );
    expect(ev!.diff!.shared).toBe(true);
    // The block must not claim these are the worker's changes.
    expect(formatHandoffEvidence(ev!)).toContain("SHARED with the parent");
  });

  it("flags a diff taken in a configured shared checkout", async () => {
    const ev = await collectHandoffEvidence(
      "bks-child",
      evidenceDeps({ isSharedCheckout: () => true }),
    );
    expect(ev!.diff!.shared).toBe(true);
  });

  it("reports the run error and still returns evidence when git fails", async () => {
    const ev = await collectHandoffEvidence(
      "bks-child",
      evidenceDeps({
        getSession: () =>
          session({
            lastRunError: {
              message: "Usage limit reached",
              at: "2026-07-24T10:00:00Z",
            },
          }),
        diff: async () => {
          throw new Error("not a git repo");
        },
      }),
    );
    expect(ev!.state).toBe("error");
    expect(ev!.lastRunError).toBe("Usage limit reached");
    expect(ev!.diff).toBeUndefined();
  });

  it("returns null for an unknown session", async () => {
    expect(await collectHandoffEvidence("nope", evidenceDeps())).toBeNull();
  });
});

describe("formatHandoffEvidence", () => {
  const ev: HandoffEvidence = {
    sessionId: "bks-child",
    state: "done",
    branch: "feat/x",
    pr: { url: "https://github.com/x/y/pull/1", state: "OPEN" },
    diff: {
      files: [
        { path: "src/a.ts", status: "modified", additions: 10, deletions: 2 },
      ],
      totalAdditions: 10,
      totalDeletions: 2,
      shared: false,
      more: 3,
    },
    failures: [
      {
        tool: "bash",
        what: "bun test",
        errorTail: "1 fail",
        laterPassed: true,
      },
    ],
    commands: ["bun test", "git push"],
    usage: { turns: 2 },
  };

  it("renders the facts and marks itself as server-computed", () => {
    const out = formatHandoffEvidence(ev);
    expect(out).toContain("computed by the server, not written by the worker");
    expect(out).toContain("PR: OPEN https://github.com/x/y/pull/1");
    expect(out).toContain("src/a.ts (+10/-2)");
    expect(out).toContain("… +3 more");
    expect(out).toContain("✗ bash: bun test");
    expect(out).toContain("a later attempt got past this");
    expect(out).toContain("commands run: bun test, git push");
    expect(out).toContain("not as passed");
  });

  it("stays small enough to staple onto a handoff", () => {
    expect(formatHandoffEvidence(ev).length).toBeLessThan(1500);
  });

  it("drops the shell-exit caveat when no commands were run", () => {
    const quiet: HandoffEvidence = {
      sessionId: "bks-child",
      state: "done",
      failures: [],
      commands: [],
    };
    expect(formatHandoffEvidence(quiet)).not.toContain("not as passed");
  });
});

// ---------------------------------------------------------------------------
// Failure beacon
// ---------------------------------------------------------------------------

function beacon(
  file: Record<string, unknown> | null,
  over: Partial<BeaconDeps> = {},
): {
  deps: BeaconDeps;
  delivered: { to: string; content: string; deliveryId: string }[];
  stamped: string[];
} {
  const delivered: { to: string; content: string; deliveryId: string }[] = [];
  const stamped: string[] = [];
  return {
    delivered,
    stamped,
    deps: {
      readSessionFile: () => file,
      stamp: (id) => {
        stamped.push(id);
      },
      deliver: async (to, content, deliveryId) => {
        delivered.push({ to, content, deliveryId });
      },
      evidence: async () => null,
      now: () => Date.parse("2026-07-24T12:00:00Z"),
      ...over,
    },
  };
}

describe("notifyParentOfFailedRun", () => {
  it("tells the parent when a reporting worker dies", async () => {
    const b = beacon({ parentSessionId: "bks-parent", reportBack: true });
    expect(
      await notifyParentOfFailedRun("bks-child", "Usage limit reached", b.deps),
    ).toBe("sent");
    expect(b.delivered[0]!.to).toBe("bks-parent");
    expect(b.delivered[0]!.content).toStartWith(
      "<!--os:worker-report:bks-child-->",
    );
    expect(b.delivered[0]!.content).toContain(
      "ended in error without reporting back",
    );
    expect(b.delivered[0]!.content).toContain("Usage limit reached");
    expect(b.stamped).toEqual(["bks-child"]);
  });

  it("attaches the evidence block when there is one", async () => {
    const b = beacon(
      { parentSessionId: "bks-parent", reportBack: true },
      {
        evidence: async () => ({
          sessionId: "bks-child",
          state: "error",
          failures: [
            {
              tool: "bash",
              what: "bun test",
              errorTail: "1 fail",
              laterPassed: false,
            },
          ],
          commands: ["bun test"],
        }),
      },
    );
    await notifyParentOfFailedRun("bks-child", "boom", b.deps);
    expect(b.delivered[0]!.content).toContain("✗ bash: bun test");
  });

  it("stays quiet for a session with no parent", async () => {
    const b = beacon({ id: "bks-solo" });
    expect(await notifyParentOfFailedRun("bks-solo", "boom", b.deps)).toBe(
      "no-parent",
    );
    expect(b.delivered).toHaveLength(0);
  });

  it("stays quiet for a child told not to report back", async () => {
    const b = beacon({ parentSessionId: "bks-parent" });
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "no-parent",
    );
  });

  it("defers to the worker's own report when it just sent one", async () => {
    const b = beacon({
      parentSessionId: "bks-parent",
      reportBack: true,
      lastReportToParentAt: "2026-07-24T11:59:00Z",
    });
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "already-reported",
    );
    expect(b.delivered).toHaveLength(0);
  });

  it("throttles repeat beacons from a worker failing in a loop", async () => {
    const b = beacon({
      parentSessionId: "bks-parent",
      reportBack: true,
      parentNotifiedAt: "2026-07-24T11:55:00Z",
    });
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "throttled",
    );
    expect(b.delivered).toHaveLength(0);
  });

  it("beacons again once the throttle window has passed", async () => {
    const b = beacon({
      parentSessionId: "bks-parent",
      reportBack: true,
      parentNotifiedAt: "2026-07-24T11:00:00Z",
    });
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "sent",
    );
  });

  it("does not stamp a failed delivery and can retry the stable destination", async () => {
    let attempts = 0;
    const b = beacon(
      { parentSessionId: "bks-parent", reportBack: true },
      {
        deliver: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary delivery failure");
        },
      },
    );
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "failed",
    );
    expect(b.stamped).toEqual([]);
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "sent",
    );
    expect(attempts).toBe(2);
    expect(b.stamped).toEqual(["bks-child"]);
  });

  it("keeps a projected beacon payload immutable after delivery succeeds", async () => {
    const accepted = new Map<string, string>();
    let stampAttempts = 0;
    let evidenceCalls = 0;
    const b = beacon(
      { parentSessionId: "bks-parent", reportBack: true },
      {
        evidence: async () => {
          evidenceCalls += 1;
          return {
            sessionId: "bks-child",
            state: "error",
            failures: [],
            commands: [`mutable-${evidenceCalls}`],
          };
        },
        deliver: async (_to, content, deliveryId) => {
          const prior = accepted.get(deliveryId);
          if (prior !== undefined && prior !== content)
            throw new Error("delivery identity payload changed");
          accepted.set(deliveryId, content);
        },
        stamp: () => {
          stampAttempts += 1;
          if (stampAttempts === 1)
            throw new Error("stamp failed after delivery");
        },
      },
    );
    expect(
      await notifyParentOfFailedRun(
        "bks-child",
        "boom",
        b.deps,
        "outcome:run-one",
      ),
    ).toBe("failed");
    expect(
      await notifyParentOfFailedRun(
        "bks-child",
        "boom",
        b.deps,
        "outcome:run-one",
      ),
    ).toBe("sent");
    expect(accepted.size).toBe(1);
    expect(evidenceCalls).toBe(0);
  });

  it("uses a new destination for a later projected failure after throttle", async () => {
    let now = Date.parse("2026-07-24T12:00:00Z");
    const file: Record<string, unknown> = {
      parentSessionId: "bks-parent",
      reportBack: true,
    };
    const deliveryIds: string[] = [];
    const deps: BeaconDeps = {
      readSessionFile: () => file,
      stamp: (_id, at) => {
        file.parentNotifiedAt = at;
      },
      deliver: async (_to, _content, deliveryId) => {
        deliveryIds.push(deliveryId);
      },
      evidence: async () => null,
      now: () => now,
    };
    expect(
      await notifyParentOfFailedRun(
        "bks-child",
        "first failure",
        deps,
        "outcome:run-one",
      ),
    ).toBe("sent");
    now += 11 * 60_000;
    expect(
      await notifyParentOfFailedRun(
        "bks-child",
        "different second failure",
        deps,
        "outcome:run-two",
      ),
    ).toBe("sent");
    expect(deliveryIds).toEqual([
      "worker-failure:bks-child:outcome:run-one",
      "worker-failure:bks-child:outcome:run-two",
    ]);
  });

  it("never throws out of a run-end path", async () => {
    const b = beacon(
      { parentSessionId: "bks-parent", reportBack: true },
      {
        deliver: async () => {
          throw new Error("delivery exploded");
        },
      },
    );
    expect(await notifyParentOfFailedRun("bks-child", "boom", b.deps)).toBe(
      "failed",
    );
  });
});
