import { describe, expect, test } from "bun:test";

describe("graceful shutdown listener", () => {
  test("keeps HTTP available until the bounded run drain finishes", async () => {
    const source = await Bun.file(
      new URL("../../opensession.ts", import.meta.url),
    ).text();
    const shutdown = source.indexOf("const gracefulShutdown = async");
    const drain = source.indexOf(
      "const surviving = activeDetachedAgentRunCount()",
      shutdown,
    );
    const stop = source.indexOf("server.stop()", shutdown);

    expect(shutdown).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(shutdown);
    expect(stop).toBeGreaterThan(drain);
  });
});
