import { RESTART_QUEUE_NOTICE_MESSAGE } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "./types";

export const RESTART_QUEUE_NOTICE_ENTRY_ID = "live-restart-queue-notice";

export function restartQueueNoticeEntryId(message: string): string | null {
  return message === RESTART_QUEUE_NOTICE_MESSAGE
    ? RESTART_QUEUE_NOTICE_ENTRY_ID
    : null;
}

export function hasRestartQueueNotice(
  entries: readonly TranscriptEntry[],
): boolean {
  return entries.some((entry) => entry.id === RESTART_QUEUE_NOTICE_ENTRY_ID);
}

export function withoutRestartQueueNotice(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  return entries.filter((entry) => entry.id !== RESTART_QUEUE_NOTICE_ENTRY_ID);
}
