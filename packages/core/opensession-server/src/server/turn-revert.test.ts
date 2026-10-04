import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionKernelStore } from "./session-kernel/store";
import { TranscriptStore } from "./transcript-store";
import { createTurnRevertService } from "./turn-revert";
import { captureTurnWorkspace } from "./turn-workspace-checkpoint";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "turn-revert-service-"));
  const cwd = join(root, "repo");
  await git(root, "init", "-b", "feature", cwd);
  await git(cwd, "config", "user.email", "test@example.test");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "file"), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "initial");
  const kernel = new SessionKernelStore(join(root, "actor.sqlite"));
  const transcript = new TranscriptStore(join(root, "actor.sqlite"));
  const sessionId = "os-revert-service";
  const turnId = "turn-1";
  kernel.putSessionMetadata({
    op: "put",
    sessionId,
    requestId: "seed",
    expectedRev: null,
    rev: 1,
    doc: JSON.stringify({
      id: sessionId,
      worktreeDir: cwd,
      piSessionId: "engine-old",
      mode: "code",
    }),
    archived: false,
    lastActivityMs: 0,
  });
  transcript.appendTranscriptEvents(sessionId, [
    {
      id: turnId,
      type: "user",
      content: "edit",
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      id: "answer-1",
      type: "assistant",
      content: "done",
      timestamp: "2026-01-01T00:00:01Z",
    },
  ]);
  await captureTurnWorkspace({ cwd, sessionId, turnId }, "before", {
    engineId: "engine-old",
    file: "old.jsonl",
    leafId: null,
  });
  await writeFile(join(cwd, "file"), "after\n");
  await writeFile(join(cwd, "created"), "new\n");
  await captureTurnWorkspace({ cwd, sessionId, turnId }, "after");
  cleanup.push(async () => {
    transcript.close();
    kernel.close();
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    session: async () => JSON.parse(kernel.sessionMetadata(sessionId)!.doc),
    eligible: async () => {},
    busy: () => false,
    siblings: async () => [] as string[],
    queued: async () => false,
    actor: async <
      T extends import("./session-kernel/revert-protocol").RevertActorRequest,
    >(
      request: T,
    ) => transcript.applyRevertActorRequest(request),
    outline: async () => {
      const page = transcript.readTail(sessionId, 200);
      return {
        entries: page.entries,
        lastSeq: transcript.getLastSeq(sessionId),
      };
    },
    branch: async () => "engine-new",
    engineExists: async () => true,
    publish: async () => {},
    recoveryNeeded: async () => true,
    exportPending: async () => false,
  };
  return {
    cwd,
    sessionId,
    turnId,
    kernel,
    transcript,
    options,
    service: createTurnRevertService(options),
  };
}
test("revert and undo restore files and branch pointers without moving HEAD or the staging index", async () => {
  const f = await fixture();
  const head = await git(f.cwd, "rev-parse", "HEAD");
  const index = await readFile(join(f.cwd, ".git/index"));
  const preview = await f.service.preview(f.sessionId, f.turnId);
  expect(preview.files.sort()).toEqual(["created", "file"]);
  await f.service.revert(f.sessionId, f.turnId, preview.currentTree);
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("before\n");
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-new");
  const undoPreview = await f.service.preview(f.sessionId, f.turnId);
  await f.service.undo(f.sessionId, undoPreview.currentTree);
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("after\n");
  expect(await readFile(join(f.cwd, "created"), "utf8")).toBe("new\n");
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-old");
  expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(f.cwd, ".git/index"))).toEqual(index);
});
test("busy, sibling activity and moved HEAD refuse before changing workspace files", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.sessionId, f.turnId);
  await expect(
    createTurnRevertService({ ...f.options, busy: () => true }).revert(
      f.sessionId,
      f.turnId,
      preview.currentTree,
    ),
  ).rejects.toThrow("active run");
  await expect(
    createTurnRevertService({
      ...f.options,
      siblings: async () => ["other"],
    }).revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow("Another session");
  await git(f.cwd, "add", ".");
  await git(f.cwd, "commit", "-m", "manual commit");
  await expect(
    f.service.revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow("Commits changed");
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("after\n");
});
test("crash after filesystem restore recovers the pre-revert workspace before admission", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.sessionId, f.turnId);
  const crashing = createTurnRevertService({
    ...f.options,
    afterRestore: async () => {
      throw new Error("simulated crash");
    },
  });
  await expect(
    crashing.revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow("simulated crash");
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("before\n");
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(true);
  await f.service.recover(f.sessionId);
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("after\n");
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(false);
  expect(
    JSON.parse(f.kernel.sessionMetadata(f.sessionId)!.doc).piSessionId,
  ).toBe("engine-old");
  expect(f.transcript.readTail(f.sessionId).entries).toHaveLength(2);
});
test("recovery never overwrites later commits; explicit discard leaves files intact", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.sessionId, f.turnId);
  await expect(
    createTurnRevertService({
      ...f.options,
      afterRestore: async () => {
        throw new Error("crash");
      },
    }).revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow();
  await writeFile(join(f.cwd, "file"), "manual\n");
  await git(f.cwd, "add", ".");
  await git(f.cwd, "commit", "-m", "manual");
  await expect(f.service.recover(f.sessionId)).rejects.toThrow(
    "needs attention",
  );
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(true);
  await f.service.discard(f.sessionId);
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("manual\n");
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(false);
});

test("post-crash manual uncommitted edits fail closed too", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.sessionId, f.turnId);
  await expect(
    createTurnRevertService({
      ...f.options,
      afterRestore: async () => {
        throw new Error("crash");
      },
    }).revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow();
  await writeFile(join(f.cwd, "file"), "manual uncommitted\n");
  await expect(f.service.recover(f.sessionId)).rejects.toThrow(
    "workspace files changed",
  );
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe(
    "manual uncommitted\n",
  );
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(true);
});

test("committed pointer with a stale gateway projection is reconciled, not rolled back", async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.sessionId, f.turnId);
  let publishingFailed = true;
  let refreshed = false;
  const service = createTurnRevertService({
    ...f.options,
    session: async () => ({
      id: f.sessionId,
      worktreeDir: f.cwd,
      piSessionId: refreshed ? "engine-new" : "engine-old",
      mode: "code",
    }),
    publish: async () => {
      if (publishingFailed) throw new Error("export failed");
      refreshed = true;
    },
  });
  await expect(
    service.revert(f.sessionId, f.turnId, preview.currentTree),
  ).rejects.toThrow("export failed");
  expect(f.kernel.hasRevertIntent(f.sessionId)).toBe(false);
  publishingFailed = false;
  await service.recover(f.sessionId);
  expect(refreshed).toBe(true);
  expect(await readFile(join(f.cwd, "file"), "utf8")).toBe("before\n");
  expect(f.transcript.readTail(f.sessionId).entries).toHaveLength(3);
});
