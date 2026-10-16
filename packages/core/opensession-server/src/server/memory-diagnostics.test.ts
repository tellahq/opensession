import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEEP_HEAP_SNAPSHOTS,
  heapSnapshotInFlight,
  memoryDiagnostics,
  writeHeapSnapshot,
} from "./memory-diagnostics";
import { readMemoryProbes, registerMemoryProbe } from "./memory-probes";
import { isHostOperator } from "./routes/memory-diagnostics";

describe("memory probes", () => {
  test("report every registered structure and isolate a failing probe", () => {
    registerMemoryProbe("test.sized", () => 7);
    registerMemoryProbe("test.broken", () => {
      throw new Error("not ready");
    });
    const report = readMemoryProbes();
    expect(report["test.sized"]).toBe(7);
    expect(report["test.broken"]).toEqual({ error: "not ready" });
  });
});

describe("memoryDiagnostics", () => {
  test("includes process, heap, allocator and structure sizes", () => {
    registerMemoryProbe("test.map", () => ({ entries: 3 }));
    const report = memoryDiagnostics();
    expect(report.process.rss).toBeGreaterThan(0);
    expect(report.heap.heapSize).toBeGreaterThan(0);
    expect(report.heap.objectCount).toBeGreaterThan(0);
    expect(
      Object.keys(report.heap.objectTypeCounts).length,
    ).toBeLessThanOrEqual(30);
    expect(report.allocator.jsc.current).toBeGreaterThan(0);
    expect(report.structures["test.map"]).toEqual({ entries: 3 });
    expect(report.pid).toBe(process.pid);
  });
});

describe("writeHeapSnapshot", () => {
  test("writes an owner-only snapshot, single-flights, and keeps the newest few", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-heap-test-"));
    try {
      for (let i = 0; i < KEEP_HEAP_SNAPSHOTS + 2; i++)
        await writeFile(join(dir, `gateway-2000-01-0${i}.heapsnapshot`), "{}");
      let generated = 0;
      const options = {
        dir,
        generate: () => {
          generated += 1;
          return '{"snapshot":{}}';
        },
        now: () => new Date("2099-01-01T00:00:00Z"),
        freeBytes: async () => Number.MAX_SAFE_INTEGER,
      };
      const a = writeHeapSnapshot(options);
      const b = writeHeapSnapshot(options);
      expect(heapSnapshotInFlight()).toBe(true);
      const [first, second] = await Promise.all([a, b]);
      expect(first).toBe(second);
      expect(generated).toBe(1);
      expect(heapSnapshotInFlight()).toBe(false);
      expect(first.bytes).toBe(15);
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      const files = (await readdir(dir)).sort();
      expect(files.length).toBe(KEEP_HEAP_SNAPSHOTS);
      expect(files.at(-1)).toBe(first.path.split("/").at(-1));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed snapshot does not wedge later requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-heap-test-"));
    try {
      await expect(
        writeHeapSnapshot({
          dir,
          generate: () => {
            throw new Error("out of memory");
          },
          freeBytes: async () => Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow("out of memory");
      expect(heapSnapshotInFlight()).toBe(false);
      const ok = await writeHeapSnapshot({
        dir,
        generate: () => "{}",
        freeBytes: async () => Number.MAX_SAFE_INTEGER,
      });
      expect(ok.bytes).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeHeapSnapshot failures", () => {
  test("a failed write leaves no snapshot file and still prunes old ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-heap-test-"));
    try {
      for (let i = 0; i < KEEP_HEAP_SNAPSHOTS + 2; i++)
        await writeFile(join(dir, `gateway-2000-01-0${i}.heapsnapshot`), "{}");
      await writeFile(join(dir, "gateway-old.heapsnapshot.partial"), "{");
      await expect(
        writeHeapSnapshot({
          dir,
          generate: () => '{"snapshot":{}}',
          freeBytes: async () => Number.MAX_SAFE_INTEGER,
          write: async (path, data) => {
            // Simulate ENOSPC after part of the file reached disk.
            await writeFile(path, data.slice(0, 5));
            throw Object.assign(new Error("no space left on device"), {
              code: "ENOSPC",
            });
          },
          now: () => new Date("2099-01-01T00:00:00Z"),
        }),
      ).rejects.toThrow("no space left on device");
      const files = (await readdir(dir)).sort();
      expect(files.some((name) => name.includes("2099"))).toBe(false);
      expect(files.some((name) => name.endsWith(".partial"))).toBe(false);
      expect(files.length).toBe(KEEP_HEAP_SNAPSHOTS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a snapshot that would nearly fill the disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-heap-test-"));
    try {
      let wrote = false;
      await expect(
        writeHeapSnapshot({
          dir,
          generate: () => "{}",
          freeBytes: async () => 1024,
          write: async () => {
            wrote = true;
          },
        }),
      ).rejects.toThrow("not enough free disk space");
      expect(wrote).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("memory diagnostics access", () => {
  test("with sign-in on, only the host's machine identity is allowed", () => {
    expect(isHostOperator({ authUser: null }, true)).toBe(false);
    expect(
      isHostOperator({ authUser: { login: "octocat", name: "Octo" } }, true),
    ).toBe(false);
    expect(
      isHostOperator(
        {
          authUser: {
            login: "opensession-automation",
            name: "Automation",
            automation: true,
          },
        },
        true,
      ),
    ).toBe(true);
  });

  test("with sign-in off, the single local operator is allowed", () => {
    expect(isHostOperator({ authUser: null }, false)).toBe(true);
  });
});
