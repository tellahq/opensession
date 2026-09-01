import { describe, expect, test } from "bun:test";
import { isTimelineOnlyRunnerNotice } from "./runner-events";

describe("isTimelineOnlyRunnerNotice", () => {
  test("recognizes legacy model fallback stream chunks", () => {
    expect(
      isTimelineOnlyRunnerNotice(
        "\n\n[runner] Fable 5 is out of usage on all accounts; falling back to GPT-5.6 Sol.\n\n",
      ),
    ).toBe(true);
    expect(
      isTimelineOnlyRunnerNotice(
        "[runner] Opus 5 hit a transient failure; falling back to GPT-5.6 Sol.",
      ),
    ).toBe(true);
  });

  test("keeps ordinary assistant and diagnostic text", () => {
    expect(
      isTimelineOnlyRunnerNotice("Falling back to the simpler implementation."),
    ).toBe(false);
    expect(
      isTimelineOnlyRunnerNotice("[runner] account rotation complete"),
    ).toBe(false);
  });
});
