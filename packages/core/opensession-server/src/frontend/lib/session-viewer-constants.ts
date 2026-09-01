import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { SubagentRef } from "../components/SubagentPane";
import type { ReplySuggestion } from "./reply-suggestions";
import type { TranscriptEntry } from "./types";
import { HISTORY_PAGE_ENTRIES } from "./transcript-history";

// Stable identity for "no sub-agent open", so the default prop doesn't hand
// the memoized transcript a fresh array on every render.
export const NO_SUBAGENTS: SubagentRef[] = [];
export const NO_WORKFLOW_RUNS: WorkflowRunSnapshot[] = [];
// Same reason: the empty row is set on every stream_start, and a fresh array
// each time would re-render the composer block for nothing.
export const EMPTY_SUGGESTIONS: ReplySuggestion[] = [];
// And again for the Review tab's repo list, which a promoted PR replaces with
// an empty one: PrPanel memoizes its targets on this array.
export const NO_REVIEW_REPOS: Array<{ repo: string; primary: boolean }> = [];
// Hidden for at least this long, returning to the tab is a "reopen" — jump to
// the live edge even if nothing new arrived. Shorter absences (glancing at a
// notification) keep the reader's place unless the transcript grew meanwhile.
export const HIDDEN_REOPEN_MS = 30_000;
// After becoming visible again, keep watching this long for growth that lands
// late: on the iOS PWA the WebSocket only reconnects after visibility, so what
// streamed while backgrounded arrives moments after the visibilitychange.
export const RESUME_GROWTH_WINDOW_MS = 8_000;
// Positive settlement normally lifts the opening curtain first. These deadlines
// are fail-safes: legacy transcripts have no structural outline callback, while
// an indexed transcript must never stay invisible if its index or visible-range
// callback is delayed or lost. Indexed opens get longer to avoid exposing the
// bounded tail just before the complete outline lands on a busy phone.
export const LEGACY_OPEN_SETTLE_MAX_MS = 350;
export const INDEXED_OPEN_SETTLE_MAX_MS = 2_500;
// "Jump to the start of the session" walks the backlog a page at a time rather
// than asking for it in one frame: a multi-thousand-entry transcript would be a
// tens-of-MB payload and one giant reconciliation. Fat pages keep the number of
// round trips (and whole-transcript re-renders) in single digits; the ceiling
// stops a runaway walk on a session nobody should be rendering whole — when it
// trips, the pill stays put so the reader can keep going deliberately.
export const JUMP_PAGE_ENTRIES = HISTORY_PAGE_ENTRIES;
export const JUMP_MAX_ENTRIES = 4_000;
export const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = [];
