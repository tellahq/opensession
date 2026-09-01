import { afterEach, describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorOperation } from "@tellahq/opensession-protocol/executor";
import { LocalExecutor } from "./local";

const roots: string[] = [];
const executors: LocalExecutor[] = [];
const context = {
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 1,
  requestId: "request-1",
};

afterEach(async () => {
  await Promise.allSettled(
    executors.splice(0).map((executor) => executor.close()),
  );
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  options: Partial<Parameters<typeof LocalExecutor.create>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "local-executor-"));
  roots.push(root);
  const executor = await LocalExecutor.create({
    rootId: context.rootId,
    rootPath: root,
    ...options,
  });
  executors.push(executor);
  return { root, executor };
}

async function execute(executor: LocalExecutor, operation: ExecutorOperation) {
  return executor.execute(context, operation);
}

async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error("local executor test timed out");
    await Bun.sleep(10);
  }
}

async function processIsLive(pid: number): Promise<boolean> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value[value.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
}

describe("LocalExecutor", () => {
  test("performs structured filesystem operations", async () => {
    const { root, executor } = await setup();
    await execute(executor, {
      kind: "fs.mkdir",
      path: "dir",
      recursive: false,
      idempotencyKey: "mkdir",
    });
    await execute(executor, {
      kind: "fs.write",
      path: "dir/a.txt",
      data: "hello",
      encoding: "utf8",
      idempotencyKey: "write",
    });
    const read = await execute(executor, {
      kind: "fs.read",
      path: "dir/a.txt",
    });
    expect(read.outcome).toMatchObject({
      kind: "fs.read",
      size: 5,
      binary: false,
    });
    expect(read.events?.[0]).toMatchObject({
      kind: "text",
      data: "hello",
      eof: true,
    });

    const listed = await execute(executor, {
      kind: "fs.list",
      path: ".",
      recursive: true,
    });
    expect(listed.outcome).toMatchObject({
      kind: "fs.list",
      entries: [
        { path: "dir", type: "directory" },
        { path: "dir/a.txt", type: "file", size: 5 },
      ],
    });
    const stated = await execute(executor, {
      kind: "fs.stat",
      path: "dir/a.txt",
    });
    expect(stated.outcome).toMatchObject({
      kind: "fs.stat",
      entry: { path: "dir/a.txt", type: "file", size: 5 },
    });

    await execute(executor, {
      kind: "fs.move",
      from: "dir/a.txt",
      to: "dir/b.txt",
      idempotencyKey: "move",
    });
    expect(await readFile(join(root, "dir/b.txt"), "utf8")).toBe("hello");
    await execute(executor, {
      kind: "fs.remove",
      path: "dir",
      recursive: true,
      idempotencyKey: "remove",
    });
    await expect(readFile(join(root, "dir/b.txt"))).rejects.toThrow();
  });

  test("rejects traversal, absolute paths, and symlink escapes including nonexistent targets", async () => {
    const { root, executor } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "local-executor-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret"), "secret");
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "dangling.txt"), join(root, "dangling"));

    for (const operation of [
      { kind: "fs.read", path: "../secret" },
      { kind: "fs.read", path: join(outside, "secret") },
      { kind: "fs.read", path: "escape/secret" },
      {
        kind: "fs.write",
        path: "escape/new/deep.txt",
        data: "bad",
        encoding: "utf8",
        idempotencyKey: "escape-write",
      },
      {
        kind: "fs.write",
        path: "dangling",
        data: "bad",
        encoding: "utf8",
        idempotencyKey: "dangling-write",
      },
    ] satisfies ExecutorOperation[]) {
      await expect(execute(executor, operation)).rejects.toThrow();
    }
    await expect(readFile(join(outside, "new/deep.txt"))).rejects.toThrow();
    await expect(readFile(join(outside, "dangling.txt"))).rejects.toThrow();
  });

  test("spawns native argv without a shell and reports process output", async () => {
    const { root, executor } = await setup();
    const literal = "$(touch should-not-exist);$HOME";
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/printf",
      args: ["%s", literal],
      cwd: ".",
      stdin: "closed",
      idempotencyKey: "spawn",
    });
    expect(spawned.outcome.kind).toBe("process");
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");

    let output = "";
    let exited = false;
    for (let attempt = 0; attempt < 50 && !exited; attempt++) {
      const status = await execute(executor, {
        kind: "process.status",
        processId: spawned.outcome.processId,
      });
      output +=
        status.events
          ?.flatMap((event) => (event.kind === "text" ? [event.data] : []))
          .join("") ?? "";
      exited =
        status.outcome.kind === "process" && status.outcome.state === "exited";
      if (!exited) await Bun.sleep(10);
    }
    expect(exited).toBe(true);
    expect(output).toBe(literal);
    await expect(readFile(join(root, "should-not-exist"))).rejects.toThrow();
  });

  test("caps verbose output and explicitly reports truncation", async () => {
    const { executor } = await setup({
      maxTrackedProcesses: 1,
      maxPendingOutputBytesPerProcess: 1024,
      maxPendingOutputBytesOverall: 1024,
    });
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/printf",
      args: ["%01000d", "1"],
      idempotencyKey: "verbose",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(20);
    const status = await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    const output =
      status.events
        ?.flatMap((event) => (event.kind === "text" ? [event.data] : []))
        .join("") ?? "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
    expect(output).toContain("[truncated]\n");
  });

  test("preserves UTF-8 characters split across output chunks", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time; os.write(1,b'\\xe2\\x82'); time.sleep(.02); os.write(1,b'\\xac')",
      ],
      idempotencyKey: "utf8",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    const output: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await execute(executor, {
        kind: "process.status",
        processId: spawned.outcome.processId,
      });
      output.push(
        ...(status.events?.flatMap((event) =>
          event.kind === "text" ? [event.data] : [],
        ) ?? []),
      );
      if (output.join("") === "€") break;
      await Bun.sleep(10);
    }
    expect(output.join("")).toBe("€");
  });

  test("resumes buffering after a truncation backlog is observed", async () => {
    const { executor } = await setup({
      maxTrackedProcesses: 1,
      maxPendingOutputBytesPerProcess: 1024,
      maxPendingOutputBytesOverall: 1024,
    });
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time; os.write(1,b'x'*1000); time.sleep(.1); os.write(1,b'later')",
      ],
      idempotencyKey: "resume",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(30);
    const first = await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    expect(
      first.events?.some(
        (event) => event.kind === "text" && event.data.includes("[truncated]"),
      ),
    ).toBe(true);
    await Bun.sleep(120);
    const terminal = await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    expect(
      terminal.events
        ?.flatMap((event) => (event.kind === "text" ? [event.data] : []))
        .join(""),
    ).toContain("later");
  });

  test("coalesces tiny writes and bounds retained event count", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time\nfor i in range(1000000):\n os.write(1,b'x')\n if i%10000==0: time.sleep(.001)",
      ],
      idempotencyKey: "tiny",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(300);
    expect(
      executor.bufferedProcessStats(spawned.outcome.processId).chunks,
    ).toBeLessThanOrEqual(4095);
    const status = await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    expect(status.events?.length).toBeLessThanOrEqual(4096);
    expect(status.events?.map((event) => event.sequence)).toEqual(
      status.events?.map((_, index) => index),
    );
  });

  test("merges deliberately spaced tiny callbacks into bounded blocks", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time\nfor _ in range(200):\n os.write(1,b'x')\n time.sleep(.001)",
      ],
      idempotencyKey: "spaced-tiny",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(300);
    expect(
      executor.bufferedProcessStats(spawned.outcome.processId).chunks,
    ).toBe(1);
  });

  test("charges alternating channel chunks and metadata to the retained budget", async () => {
    const { executor } = await setup({
      maxTrackedProcesses: 1,
      maxPendingOutputBytesPerProcess: 4096,
      maxPendingOutputBytesOverall: 4096,
    });
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time\nfor i in range(400):\n os.write(1 if i%2==0 else 2,b'x')\n time.sleep(.0005)",
      ],
      idempotencyKey: "alternating-tiny",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(300);
    const stats = executor.bufferedProcessStats(spawned.outcome.processId);
    expect(stats.retainedBytes).toBe(
      stats.allocatedBytes + stats.metadataBytes,
    );
    expect(stats.retainedBytes).toBeLessThanOrEqual(4096);
    expect(stats.events).toBeLessThanOrEqual(4096);
    expect(stats.chunks).toBeLessThanOrEqual(8192);
  });

  test("rejects new work at active capacity", async () => {
    const { executor } = await setup({ maxTrackedProcesses: 1 });
    await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "running",
    });
    await expect(
      execute(executor, {
        kind: "process.spawn",
        executable: "/bin/true",
        args: [],
        idempotencyKey: "busy",
      }),
    ).rejects.toMatchObject({ code: "executor_busy" });
  });

  test("uses unique batch streams and retries terminal status idempotently", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time; os.write(1,b'a'); time.sleep(.08); os.write(2,b'b')",
      ],
      idempotencyKey: "batches",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    const processId = spawned.outcome.processId;
    const first = await waitUntil(async () => {
      const current = await execute(executor, {
        kind: "process.status",
        processId,
      });
      return current.events?.length ? current : undefined;
    });
    if (first.outcome.kind !== "process") throw new Error("unexpected outcome");
    const firstStreamId = first.outcome.streamId;
    expect(first.events?.map((event) => event.sequence)).toEqual([0]);
    expect(
      first.events?.every((event) => event.streamId === firstStreamId),
    ).toBe(true);
    await Bun.sleep(100);
    const terminal = await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    if (terminal.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    const terminalStreamId = terminal.outcome.streamId;
    expect(terminal.outcome).toMatchObject({ state: "exited", exitCode: 0 });
    expect(terminalStreamId).not.toBe(firstStreamId);
    expect(terminal.events?.map((event) => event.sequence)).toEqual(
      terminal.events?.map((_, index) => index),
    );
    expect(
      terminal.events?.every((event) => event.streamId === terminalStreamId),
    ).toBe(true);
    expect(
      await execute(executor, {
        kind: "process.status",
        processId: spawned.outcome.processId,
      }),
    ).toEqual(terminal);
  });

  test("evicts a terminal tombstone only after durable acknowledgement", async () => {
    const { executor } = await setup({ maxTrackedProcesses: 1 });
    const first = await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/true",
      args: [],
      idempotencyKey: "first",
    });
    if (first.outcome.kind !== "process") throw new Error("unexpected outcome");
    await Bun.sleep(20);
    await expect(
      execute(executor, {
        kind: "process.spawn",
        executable: "/bin/true",
        args: [],
        idempotencyKey: "blocked",
      }),
    ).rejects.toMatchObject({ code: "executor_busy" });
    const terminal = await execute(executor, {
      kind: "process.status",
      processId: first.outcome.processId,
    });
    expect(terminal.outcome).toMatchObject({ state: "exited" });
    await expect(
      execute(executor, {
        kind: "process.spawn",
        executable: "/bin/true",
        args: [],
        idempotencyKey: "still-blocked",
      }),
    ).rejects.toMatchObject({ code: "executor_busy" });
    executor.acknowledgeDurableTerminal(
      context,
      { kind: "process.status", processId: first.outcome.processId },
      terminal.outcome,
    );
    await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/true",
      args: [],
      idempotencyKey: "admitted",
    });
    await expect(
      execute(executor, {
        kind: "process.status",
        processId: first.outcome.processId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("sinks an immediate spawn error during close", async () => {
    const { executor } = await setup();
    await execute(executor, {
      kind: "process.spawn",
      executable: "/definitely/missing/local-executor-command",
      args: [],
      idempotencyKey: "enoent-close",
    });
    await expect(executor.close()).resolves.toBeUndefined();
  });

  test("close fences an in-flight spawn admission", async () => {
    const { executor } = await setup();
    const spawning = execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "racing",
    });
    const closing = executor.close();
    await expect(spawning).rejects.toMatchObject({ code: "operation_failed" });
    await closing;
  });

  test("close kills same-group descendants with inherited streams", async () => {
    const { root, executor } = await setup();
    await execute(executor, {
      kind: "process.spawn",
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,time\np=os.fork()\nif p==0:\n open('descendant.pid','w').write(str(os.getpid()))\n time.sleep(30)",
      ],
      idempotencyKey: "inherited-stream",
    });
    const descendantPid = await waitUntil(async () => {
      try {
        return Number(await readFile(join(root, "descendant.pid"), "utf8"));
      } catch {
        return undefined;
      }
    });
    const started = performance.now();
    await executor.close();
    expect(performance.now() - started).toBeLessThan(500);
    let alive = await processIsLive(descendantPid);
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      await Bun.sleep(10);
      alive = await processIsLive(descendantPid);
    }
    expect(alive).toBe(false);
  });

  test("does not signal a stale saved process group after exit and close", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/true",
      args: [],
      idempotencyKey: "stale-pgid",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Bun.sleep(20);
    await execute(executor, {
      kind: "process.status",
      processId: spawned.outcome.processId,
    });
    const originalProcessKill = process.kill;
    const originalChildKill = ChildProcess.prototype.kill;
    let signals = 0;
    process.kill = (() => {
      signals++;
      throw new Error("stale process group was signalled");
    }) as typeof process.kill;
    ChildProcess.prototype.kill = (() => {
      signals++;
      return false;
    }) as typeof ChildProcess.prototype.kill;
    try {
      await expect(executor.close()).resolves.toBeUndefined();
      expect(signals).toBe(0);
    } finally {
      process.kill = originalProcessKill;
      ChildProcess.prototype.kill = originalChildKill;
    }
  });

  test("falls back to direct child kill when group kill fails", async () => {
    const { executor } = await setup();
    await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "direct-fallback",
    });
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
    try {
      await expect(executor.close()).resolves.toBeUndefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test("reports failure when direct child termination cannot be confirmed", async () => {
    const { executor } = await setup();
    await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "kill-failure",
    });
    const originalProcessKill = process.kill;
    const originalChildKill = ChildProcess.prototype.kill;
    let groupPid: number | undefined;
    process.kill = ((pid: number) => {
      groupPid = pid;
      throw new Error("group kill failed");
    }) as typeof process.kill;
    ChildProcess.prototype.kill = (() =>
      false) as typeof ChildProcess.prototype.kill;
    try {
      await expect(executor.close()).rejects.toMatchObject({
        code: "operation_failed",
      });
    } finally {
      process.kill = originalProcessKill;
      ChildProcess.prototype.kill = originalChildKill;
      if (groupPid !== undefined) {
        try {
          originalProcessKill(groupPid, "SIGKILL");
        } catch {}
      }
    }
  });

  test("kill errors do not poison close cleanup", async () => {
    const { executor } = await setup();
    await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "kill-error",
    });
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      originalKill(pid, signal);
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
    try {
      await expect(executor.close()).resolves.toBeUndefined();
      await expect(executor.close()).resolves.toBeUndefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test("close terminates children, clears tracking, and is idempotent", async () => {
    const { executor } = await setup();
    const spawned = await execute(executor, {
      kind: "process.spawn",
      executable: "/bin/sleep",
      args: ["30"],
      idempotencyKey: "close",
    });
    if (spawned.outcome.kind !== "process")
      throw new Error("unexpected outcome");
    await Promise.all([executor.close(), executor.close()]);
    await expect(
      execute(executor, {
        kind: "process.status",
        processId: spawned.outcome.processId,
      }),
    ).rejects.toMatchObject({ code: "operation_failed" });
  });

  test("returns unsupported for terminal, service, and portal families", async () => {
    const { executor } = await setup();
    for (const operation of [
      {
        kind: "terminal.close",
        terminalId: "terminal",
        idempotencyKey: "terminal",
      },
      { kind: "service.status", serviceId: "service" },
      { kind: "portal.status", portalId: "portal" },
    ] satisfies ExecutorOperation[]) {
      try {
        await execute(executor, operation);
        throw new Error("expected unsupported operation");
      } catch (error: any) {
        expect(error.code).toBe("unsupported");
      }
    }
  });

  test("uses only the explicit minimal child environment", async () => {
    const { executor } = await setup();
    const secretName = "OPENSESSION_EXECUTOR_TEST_SECRET";
    process.env[secretName] = "must-not-leak";
    try {
      const spawned = await execute(executor, {
        kind: "process.spawn",
        executable: "/usr/bin/env",
        args: [],
        idempotencyKey: "env",
      });
      if (spawned.outcome.kind !== "process")
        throw new Error("unexpected outcome");
      let output = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        const status = await execute(executor, {
          kind: "process.status",
          processId: spawned.outcome.processId,
        });
        output +=
          status.events
            ?.flatMap((event) => (event.kind === "text" ? [event.data] : []))
            .join("") ?? "";
        if (
          status.outcome.kind === "process" &&
          status.outcome.state === "exited"
        )
          break;
        await Bun.sleep(10);
      }
      expect(output).not.toContain(secretName);
      expect(output).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    } finally {
      delete process.env[secretName];
    }
  });
});
