import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { formatBytes, formatStructures, memory } from "./memory";

describe("opensession memory formatting", () => {
  test("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4.18 * 1024 ** 3)).toBe("4.2 GB");
    expect(formatBytes(Number.NaN)).toBe("?");
  });

  test("lists the largest structures first", () => {
    expect(
      formatStructures({
        "a.small": 2,
        "b.large": { sessions: 900, sockets: 3 },
        "c.broken": { error: "boom" },
        "d.medium": 40,
      }),
    ).toEqual([
      "b.large  sessions=900 sockets=3",
      "d.medium  40",
      "a.small  2",
      "c.broken  error: boom",
    ]);
  });
});

describe("opensession memory --json", () => {
  afterEach(() => {
    (console.log as any).mockRestore?.();
    (console.error as any).mockRestore?.();
  });

  test.each([true, false])(
    "stdout is one JSON document (snapshot=%p)",
    async (snapshot) => {
      const out: string[] = [];
      spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        out.push(args.join(" "));
      });
      spyOn(console, "error").mockImplementation(() => {});
      const code = await memory({ json: true, snapshot }, async (path) =>
        path.endsWith("/heap-snapshot")
          ? { path: "/state/heap.heapsnapshot", bytes: 10, durationMs: 1 }
          : { process: { rss: 1 }, structures: {} },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed).toHaveProperty(snapshot ? "path" : "process");
    },
  );

  test("failures stay off stdout", async () => {
    const out: string[] = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const code = await memory({ json: true, snapshot: true }, async () => {
      throw new Error("server returned 403");
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
  });
});
