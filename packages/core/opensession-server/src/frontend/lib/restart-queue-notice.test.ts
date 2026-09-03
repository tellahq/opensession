import { describe, expect, test } from "bun:test";
import { RESTART_QUEUE_NOTICE_MESSAGE } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "./types";
import {
  RESTART_QUEUE_NOTICE_ENTRY_ID,
  hasRestartQueueNotice,
  restartQueueNoticeEntryId,
  withoutRestartQueueNotice,
} from "./restart-queue-notice";

function systemEntry(id: string, content: string): TranscriptEntry {
  return {
    id,
    type: "system",
    content,
    timestamp: "2026-09-01T12:00:00.000Z",
  };
}

describe("restart queue notice", () => {
  test("gives the restart notice a stable transient id", () => {
    expect(restartQueueNoticeEntryId(RESTART_QUEUE_NOTICE_MESSAGE)).toBe(
      RESTART_QUEUE_NOTICE_ENTRY_ID,
    );
    expect(restartQueueNoticeEntryId("Switched model")).toBeNull();
  });

  test("removes only the resolved restart notice after reconnect", () => {
    const restart = systemEntry(
      RESTART_QUEUE_NOTICE_ENTRY_ID,
      RESTART_QUEUE_NOTICE_MESSAGE,
    );
    const durable = systemEntry("durable-notice", "Switched model");

    expect(hasRestartQueueNotice([restart, durable])).toBe(true);
    expect(withoutRestartQueueNotice([restart, durable])).toEqual([durable]);
    expect(hasRestartQueueNotice([durable])).toBe(false);
  });
});
