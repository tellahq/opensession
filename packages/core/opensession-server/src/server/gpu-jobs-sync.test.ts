/**
 * Landing a session's work on a running job's machine (gpu_exec `sync`):
 * the checkpoint and the landing are faked, so what is tested is the order
 * of operations, the skip when nothing changed, and the job record.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "./sandbox/provider";
import type { UnifiedSession } from "./types";

const root = mkdtempSync(join(tmpdir(), "opensession-gpu-job-sync-"));
const previousState = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = join(root, "state");

const events: string[] = [];
let nextCommit = "c1";
let unchanged = false;
const realCheckpoint = await import("./sandbox/checkpoint");
mock.module("./sandbox/checkpoint", () => ({
  ...realCheckpoint,
  // The real one claims the session's lifecycle lane; so does this.
  // Like the real one, it hands the captured checkpoint to
  // `alongsidePush` and settles once both the push and that have.
  checkpointHostWorkspace: (
    session: { id: string },
    _dir: string,
    options: {
      alongsidePush?: (checkpoint: unknown) => Promise<void>;
      onPushed?: (ms: number) => void;
    } = {},
  ) =>
    import("./sandbox/lifecycle-lane").then(({ withSessionLifecycleLane }) =>
      withSessionLifecycleLane(session.id, async () => {
        const commit = nextCommit;
        events.push(`checkpoint ${commit}`);
        await Bun.sleep(5);
        const checkpoint = {
          ref: "refs/opensession/checkpoints/s",
          commit,
          head: "p1",
          tree: "t",
          branch: "feature",
          at: "",
        };
        if (unchanged) return { state: "unchanged" as const, checkpoint };
        const push = (async () => {
          events.push(`push start ${commit}`);
          await Bun.sleep(10);
          events.push(`push end ${commit}`);
        })();
        await Promise.all([push, options.alongsidePush?.(checkpoint)]);
        options.onPushed?.(10);
        return { state: "pushed" as const, checkpoint };
      }),
    ),
  checkpointBundle: async (_dir: string, commit: string, haves: string[]) => {
    events.push(`bundle ${commit} on ${haves.join(",")}`);
    return Buffer.from("bundle");
  },
  landCheckpointInSandbox: async (
    _repo: string,
    _sandbox: Sandbox,
    checkpoint: { commit: string },
  ) => {
    events.push(`land start ${checkpoint.commit}`);
    await Bun.sleep(20);
    events.push(`land end ${checkpoint.commit}`);
    return {
      state: "landed" as const,
      changed: ["src/a.ts"],
      head: "p1",
      bundled: true,
    };
  },
}));

const { syncGpuJob, __resetGpuJobsForTest } = await import("./gpu-jobs");
type GpuJobRecord = import("./gpu-jobs").GpuJobRecord;

afterAll(() => {
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  rmSync(root, { recursive: true, force: true });
});

const session = {
  id: "os-sync-1",
  repo: "acme",
  branch: "feature",
  worktreeDir: root,
} as UnifiedSession;
const sandbox = {
  id: "md-os-sync-1--gpu",
  cwd: "/repo",
  async exec() {
    return { exitCode: 0, stdout: "p1\n", stderr: "" };
  },
} as unknown as Sandbox;
const job = (): GpuJobRecord => ({
  id: "gj-sync",
  sessionId: session.id,
  title: "dev server",
  command: "sleep infinity",
  gpu: "T4",
  state: "running",
  startedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  commit: "p0",
  checkpoint: "c0",
});

describe("syncing a running job", () => {
  test("lands a new checkpoint and records it on the job", async () => {
    __resetGpuJobsForTest();
    events.length = 0;
    nextCommit = "c1";
    const record = job();
    const sync = await syncGpuJob(record, session, sandbox);
    expect(sync).toMatchObject({
      state: "landed",
      commit: "p1",
      checkpoint: "c1",
      changed: ["src/a.ts"],
    });
    expect(record.commit).toBe("p1");
    expect(record.checkpoint).toBe("c1");
    expect(record.lastSync).toEqual(sync as never);
    expect(sync).toMatchObject({ bundled: true, pushMs: 10 });
    // The bundle builds on the checkpoint the machine has, and the landing
    // runs while the checkpoint is pushed.
    expect(events).toEqual([
      "checkpoint c1",
      "push start c1",
      "bundle c1 on c0",
      "land start c1",
      "push end c1",
      "land end c1",
    ]);
  });

  test("the checkpoint the machine already has: nothing is landed", async () => {
    events.length = 0;
    nextCommit = "c1";
    const record = { ...job(), commit: "p1", checkpoint: "c1" };
    const sync = await syncGpuJob(record, session, sandbox);
    expect(sync).toMatchObject({ state: "unchanged", checkpoint: "c1" });
    expect(events).toEqual(["checkpoint c1", "push start c1", "push end c1"]);

    // The workspace has not changed since the session's last checkpoint,
    // which the machine has: nothing is pushed or landed.
    events.length = 0;
    unchanged = true;
    try {
      expect(await syncGpuJob(record, session, sandbox)).toMatchObject({
        state: "unchanged",
        checkpoint: "c1",
      });
    } finally {
      unchanged = false;
    }
    expect(events).toEqual(["checkpoint c1"]);
  });

  test("two syncs of one session do not interleave", async () => {
    events.length = 0;
    const record = job();
    nextCommit = "c2";
    const first = syncGpuJob(record, session, sandbox);
    // The second capture must wait for the first landing: it would
    // force-push the hidden ref the first is fetching.
    await Bun.sleep(1);
    nextCommit = "c3";
    const second = syncGpuJob(record, session, sandbox);
    await Promise.all([first, second]);
    expect(events).toEqual([
      "checkpoint c2",
      "push start c2",
      "bundle c2 on c0",
      "land start c2",
      "push end c2",
      "land end c2",
      "checkpoint c3",
      "push start c3",
      "bundle c3 on c2",
      "land start c3",
      "push end c3",
      "land end c3",
    ]);
    expect(record.checkpoint).toBe("c3");
  });
});
