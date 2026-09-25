import { describe, expect, test } from "bun:test";
import { archiveSleepSkipReason } from "./sandbox-archive-sleep";

describe("archived session Sandbox sleep", () => {
  const awake = { provider: "box", sandboxId: "bx_1", lifecycle: "awake" };
  const base = { archived: true, busy: false, record: awake, canPause: true };

  test("sleeps an awake remote Sandbox of an archived, idle session", () => {
    expect(archiveSleepSkipReason(base)).toBeNull();
  });

  test("leaves it running otherwise", () => {
    expect(archiveSleepSkipReason({ ...base, archived: false })).toBe(
      "unarchived",
    );
    expect(archiveSleepSkipReason({ ...base, busy: true })).toBe(
      "turn running",
    );
    expect(
      archiveSleepSkipReason({
        ...base,
        record: { ...awake, lifecycle: "sleeping" },
      }),
    ).toBe("asleep");
    expect(
      archiveSleepSkipReason({
        ...base,
        record: { provider: "box", sandboxId: undefined },
      }),
    ).toBe("no machine");
    expect(
      archiveSleepSkipReason({
        ...base,
        record: { ...awake, provider: "local" },
      }),
    ).toBe("local");
    expect(archiveSleepSkipReason({ ...base, canPause: false })).toBe(
      "no sleep support",
    );
  });
});
