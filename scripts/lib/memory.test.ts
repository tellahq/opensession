import { describe, expect, test } from "bun:test";
import { formatBytes, formatStructures } from "./memory";

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
