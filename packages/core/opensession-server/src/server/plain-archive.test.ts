import { describe, expect, test } from "bun:test";
import { archivePlainSessionCandidates } from "./plain-archive";
import type { NativeSessionFile } from "./types";

describe("Plain archive sweep", () => {
  test("continues after one session projection is quarantined", async () => {
    const projected: string[] = [];
    const released: string[] = [];
    const failures: Array<[string, unknown]> = [];
    const sessions = ["quarantined", "healthy"].map((id) => ({
      path: `/unused/${id}.json`,
      data: { id, plainThreadId: "thread-1" } as NativeSessionFile,
    }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        projected.push(sessionId);
        if (sessionId === "quarantined") throw new Error("session quarantined");
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      (sessionId, error) => failures.push([sessionId, error]),
      (sessionId) => released.push(sessionId),
    );

    expect(archived).toBe(1);
    expect(projected).toEqual(["quarantined", "healthy"]);
    expect(released).toEqual(["healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe("quarantined");
  });
});
