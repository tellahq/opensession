import { describe, expect, test } from "bun:test";
import type { TranscriptEntry, UnifiedSession } from "../../lib/types";
import { switchDividerText } from "./model-labels";
import { withModelSwitches } from "./model-switches";

const history = (
  at: string,
): NonNullable<UnifiedSession["modelHistory"]>[number] => ({
  model: "claude-fable-5",
  from: "gpt-5.6-sol",
  at,
  by: "auto-retry — checking the original selection again",
});

const liveSwitch = (timestamp: string): TranscriptEntry => ({
  id: "model-switch-live-1",
  type: "system",
  content: switchDividerText(
    "claude-fable-5",
    "gpt-5.6-sol",
    "auto-retry — checking the original selection again",
  ),
  timestamp,
});

describe("withModelSwitches", () => {
  test("keeps the live divider mounted when session history catches up", () => {
    const live = liveSwitch("2026-08-31T13:59:01.000Z");
    const entries = [live];
    const merged = withModelSwitches(entries, [
      history("2026-08-31T13:59:00.000Z"),
    ]);

    expect(merged).toBe(entries);
    expect(merged).toEqual([live]);
  });

  test("does not match an old identical switch to a new live divider", () => {
    const live = liveSwitch("2026-08-31T14:00:00.000Z");
    const merged = withModelSwitches(
      [live],
      [history("2026-08-30T14:00:00.000Z")],
    );

    expect(merged.map((entry) => entry.id)).toEqual([
      "model-switch-2026-08-30T14:00:00.000Z",
      "model-switch-live-1",
    ]);
  });

  test("removes a duplicate live divider when durable identity is already mounted", () => {
    const item = history("2026-08-31T13:59:00.000Z");
    const durable: TranscriptEntry = {
      id: `model-switch-${item.at}`,
      type: "system",
      content: switchDividerText(item.model, item.from, item.by),
      timestamp: item.at,
    };
    const merged = withModelSwitches(
      [durable, liveSwitch("2026-08-31T13:59:01.000Z")],
      [item],
    );

    expect(merged).toEqual([durable]);
  });

  test("uses durable identity on a cold transcript open", () => {
    const merged = withModelSwitches([], [history("2026-08-31T13:59:00.000Z")]);

    expect(merged[0]?.id).toBe("model-switch-2026-08-31T13:59:00.000Z");
    expect(merged[0]?.timestamp).toBe("2026-08-31T13:59:00.000Z");
  });
});
