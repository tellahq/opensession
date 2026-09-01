import type { UnifiedSession, TranscriptEntry } from "../../lib/types";
import {
  mergeTranscriptEntries,
  orderTranscriptEntries,
} from "../../lib/transcript-state";
import { switchDividerText } from "./model-labels";

const LIVE_SWITCH_PREFIX = "model-switch-live-";
const LIVE_SWITCH_MATCH_WINDOW_MS = 60_000;

/** Pair the immediate WebSocket divider with the same switch once polled
 * session history catches up. Keeping its temporary id and timestamp preserves
 * both the mounted DOM node and its timeline position; otherwise every refresh
 * replaces it with a durable synthetic row and replays its vertical arrival. */
function claimLiveSwitch(
  entries: TranscriptEntry[],
  content: string,
  at: string,
  claimed: Set<string>,
): TranscriptEntry | undefined {
  const targetTime = Date.parse(at);
  let match: TranscriptEntry | undefined;
  let matchDistance = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (
      !entry.id.startsWith(LIVE_SWITCH_PREFIX) ||
      claimed.has(entry.id) ||
      entry.content !== content
    )
      continue;
    const distance = Math.abs(Date.parse(entry.timestamp) - targetTime);
    if (distance <= LIVE_SWITCH_MATCH_WINDOW_MS && distance < matchDistance) {
      match = entry;
      matchDistance = distance;
    }
  }
  if (match) claimed.add(match.id);
  return match;
}

export function withModelSwitches(
  entries: TranscriptEntry[],
  history: UnifiedSession["modelHistory"],
): TranscriptEntry[] {
  const claimedLiveIds = new Set<string>();
  const currentIds = new Set(entries.map((entry) => entry.id));
  const switches: TranscriptEntry[] = (history || []).map((h) => {
    const content = switchDividerText(h.model, h.from, h.by);
    const durableId = `model-switch-${h.at}`;
    const live = currentIds.has(durableId)
      ? undefined
      : claimLiveSwitch(entries, content, h.at, claimedLiveIds);
    return {
      id: live?.id ?? durableId,
      type: "system" as const,
      content,
      timestamp: live?.timestamp ?? h.at,
    };
  });
  if (switches.length === 0) return entries;
  const supersededLiveIds = new Set(
    entries
      .filter(
        (entry) =>
          entry.id.startsWith(LIVE_SWITCH_PREFIX) &&
          !claimedLiveIds.has(entry.id) &&
          (history ?? []).some(
            (item) =>
              switchDividerText(item.model, item.from, item.by) ===
                entry.content &&
              Math.abs(Date.parse(item.at) - Date.parse(entry.timestamp)) <=
                LIVE_SWITCH_MATCH_WINDOW_MS,
          ),
      )
      .map((entry) => entry.id),
  );
  const base = entries.filter((entry) => !supersededLiveIds.has(entry.id));
  const current = new Map(base.map((entry) => [entry.id, entry] as const));
  if (
    base.length === entries.length &&
    switches.every((entry) => {
      const existing = current.get(entry.id);
      return (
        existing?.content === entry.content &&
        existing.timestamp === entry.timestamp
      );
    })
  )
    return entries;
  return orderTranscriptEntries(mergeTranscriptEntries(base, switches));
}
