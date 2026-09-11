// Call-local captions bridge RTC transcript deltas to settled Desk rows.
// The server persists whole utterances; captions fill that wait without
// changing transcript storage or the server's grouping rules.

export type VoiceCaptionRole = "user" | "assistant";

export interface VoiceCaptionFragment {
  role: VoiceCaptionRole;
  delta: string;
  /** Session-timeline position, as the Live API reports it. */
  startMs: number;
  endMs: number;
}

export interface VoiceCaption {
  role: VoiceCaptionRole;
  text: string;
  /** Timeline start of the first fragment still on screen. */
  startMs: number;
}

export interface VoiceCaptionsSnapshot {
  /** At most one caption per speaker, in the order they started. */
  captions: VoiceCaption[];
  revision: number;
}

/** How long a caption outlives its call. The server flushes every open row
 * as the call ends and the mirrored entries land moments later; whatever has
 * not landed by then comes down to avoid leaving a stale caption. */
export const VOICE_CAPTION_END_GRACE_MS = 5_000;

const EMPTY: VoiceCaptionsSnapshot = { captions: [], revision: 0 };

/** Whether a settled row accounts for a fragment. The server joins every
 * fragment that starts no later than the row's end into that row, so a row
 * with a known end covers the whole span; a legacy row only covers what came
 * before it started (its own fragments are matched by text in `publish`). */
function covers(
  landed: { startMs: number; endMs: number | null },
  fragment: { startMs: number },
): boolean {
  if (fragment.startMs < landed.startMs) return true;
  return landed.endMs !== null && fragment.startMs <= landed.endMs;
}

/** Mirrored voice rows are `voice-<call>-<role>-<startMs>-end-<endMs>`,
 * spanning the row's first fragment to its last (desk-voice-live.ts). Rows
 * mirrored before the end was recorded have no `-end-` part. Typed messages
 * during a call are `voice-typed-<uuid>` and never match. */
const ROW_ID =
  /^voice-(.+)-(user|assistant)-(\d+(?:\.\d+)?)(?:-end-(\d+(?:\.\d+)?))?$/;

export function parseVoiceRowId(id: string): {
  callId: string;
  role: VoiceCaptionRole;
  startMs: number;
  /** Null for a legacy id without the `-end-` part. */
  endMs: number | null;
} | null {
  const match = ROW_ID.exec(id);
  if (!match) return null;
  return {
    callId: match[1],
    role: match[2] === "user" ? "user" : "assistant",
    startMs: Number(match[3]),
    endMs: match[4] === undefined ? null : Number(match[4]),
  };
}

export class VoiceCaptionStore {
  private fragments: Record<VoiceCaptionRole, VoiceCaptionFragment[]> = {
    user: [],
    assistant: [],
  };
  private callId: string | null = null;
  private landed: Partial<
    Record<
      VoiceCaptionRole,
      { startMs: number; endMs: number | null; text: string }
    >
  > = {};
  private snapshot: VoiceCaptionsSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: { endGraceMs?: number } = {}) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY;
  hasCaptions = () => this.snapshot.captions.length > 0;

  start(callId: string): void {
    this.clear();
    this.callId = callId;
  }

  /** A transcript fragment from the call's data channel. */
  push(fragment: VoiceCaptionFragment): void {
    if (!this.callId || !fragment.delta) return;
    this.cancelEnd();
    const landed = this.landed[fragment.role];
    if (landed && covers(landed, fragment)) return;
    this.fragments[fragment.role].push(fragment);
    this.publish();
  }

  /** A durable transcript entry arrived. A mirrored voice row takes its own
   * fragments off the screen; every other entry is ignored. A row whose id
   * carries its end covers every fragment up to that point, whatever its
   * content: the server may have rewritten what the Desk said into
   * references (desk-voice-refs.ts). */
  land(entry: { id: string; type: string; content: string }): void {
    const row = parseVoiceRowId(entry.id);
    if (!row || row.role !== entry.type || row.callId !== this.callId) return;
    const previous = this.landed[row.role];
    if (previous && previous.startMs > row.startMs) return;
    const landed = {
      startMs: row.startMs,
      endMs: row.endMs,
      text: entry.content.trim(),
    };
    this.landed[row.role] = landed;
    this.fragments[row.role] = this.fragments[row.role].filter(
      (fragment) => !covers(landed, fragment),
    );
    this.publish();
  }

  /** The call ended. Its open rows are being mirrored right now, so the tails
   * stay until they land and anything still up after the grace comes down. */
  end(): void {
    this.cancelEnd();
    if (!this.fragments.user.length && !this.fragments.assistant.length) return;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.clear();
    }, this.opts.endGraceMs ?? VOICE_CAPTION_END_GRACE_MS);
  }

  clear(): void {
    this.cancelEnd();
    this.fragments = { user: [], assistant: [] };
    this.landed = {};
    this.callId = null;
    this.publish();
  }

  private publish() {
    const captions: VoiceCaption[] = [];
    for (const role of ["user", "assistant"] as const) {
      let fragments = this.fragments[role];
      const landed = this.landed[role];
      // The sideband and RTC channel can arrive in either order. Retain the
      // latest settled row so its late RTC fragments cannot reappear. Older
      // fragments are pruned on land; only the latest row and live tail remain.
      // A row without its end (legacy id) is matched by text instead.
      if (
        landed &&
        landed.endMs === null &&
        fragments[0]?.startMs === landed.startMs
      ) {
        let joined = "";
        let hidden = 0;
        for (const fragment of fragments) {
          joined += fragment.delta;
          if (!landed.text.startsWith(joined.trim())) break;
          hidden++;
          if (joined.trim() === landed.text) break;
        }
        fragments = fragments.slice(hidden);
      }
      if (!fragments.length) continue;
      // Joined exactly as received: fragments carry their own spacing.
      const text = fragments
        .map((f) => f.delta)
        .join("")
        .trim();
      if (!text) continue;
      captions.push({ role, text, startMs: fragments[0].startMs });
    }
    captions.sort((a, b) => a.startMs - b.startMs);
    this.snapshot = { captions, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }

  private cancelEnd() {
    if (this.endTimer === null) return;
    clearTimeout(this.endTimer);
    this.endTimer = null;
  }
}
