import { selectPortableHandoff } from "./portable-handoff";
import { contextWindowFor } from "./models";
import { productName } from "./config";
import type { TranscriptEntry } from "./types";

export function buildForkHandoffNote(input: {
  sourceId: string;
  reservedBytes?: number;
  sourceTitle?: string | null;
  sourceModel?: string | null;
  targetModel?: string | null;
  messageId?: string;
  entries: TranscriptEntry[];
  maxEntries?: number;
}): string {
  let entries = input.entries;
  let boundary = "latest message";
  if (input.messageId) {
    const idx = entries.findIndex((e) => e.id === input.messageId);
    if (idx >= 0) {
      entries = entries.slice(0, idx + 1);
      boundary = `message ${input.messageId}`;
    } else {
      boundary = `latest message (requested fork point ${input.messageId} was not found)`;
    }
  }

  const transcript = selectPortableHandoff({
    entries,
    sessionId: input.sourceId,
    reservedBytes: (input.reservedBytes ?? 0) + 4000,
    contextWindow: contextWindowFor(input.targetModel || input.sourceModel),
    maxEntries: input.maxEntries,
  });

  return [
    "## Fork handoff",
    `This is a new engine thread forked from ${productName()} session ${input.sourceId} at ${boundary}.`,
    input.sourceTitle ? `Source title: ${input.sourceTitle}` : undefined,
    input.sourceModel ? `Source model: ${input.sourceModel}` : undefined,
    "The original engine cannot clone its internal conversation state here, so use this transcript handoff as context and continue the requested work in this new session.",
    transcript
      ? `Source transcript:\n${transcript}`
      : "No source transcript entries were available.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Transcript context attached from sibling sessions — the fresh-session "Add
 * session transcripts" chips. Unlike a fork (which *continues* one source
 * thread), these are parallel conversations the user pulled in as background
 * reading: the digest per session is bigger than a fork handoff, but each
 * excerpt is bounded so several attached sessions can't blow up the prompt.
 */
export function buildSessionContextNote(
  sessions: Array<{
    id: string;
    title?: string | null;
    model?: string | null;
    entries: TranscriptEntry[];
  }>,
  maxEntriesPerSession?: number,
  targetModel?: string | null,
  reservedBytes = 0,
): string {
  const sections = sessions.map((session) => {
    const transcript = selectPortableHandoff({
      entries: session.entries,
      sessionId: session.id,
      reservedBytes: reservedBytes + 4000,
      contextWindow: contextWindowFor(targetModel),
      maxEntries: maxEntriesPerSession,
      maxBytes: Math.floor(
        Math.min(64_000, (contextWindowFor(targetModel) || 128_000) / 4) /
          Math.max(1, sessions.length),
      ),
    });
    const head = `### ${session.title || "Untitled session"} — @session:${session.id}${session.model ? ` (${session.model})` : ""}`;
    return `${head}\n${transcript || "(no transcript yet)"}`;
  });

  return [
    "## Attached session transcripts",
    "The user attached transcripts of other sessions from this workspace as background context for this conversation. They are reference material from parallel conversations — the user's own message is the actual instruction. Selected messages are intact; use opensession-sessions `read_session_transcript` for omitted entries (get_session shows session details).",
    ...sections,
  ].join("\n\n");
}

/**
 * Context bridge for an *in-place* engine switch: the same Open Session session
 * flipped its model from one provider to another (e.g. a Fable orchestrator
 * handing the wheel to a gpt-5.5 executor, or vice versa). The new engine has
 * no memory of the conversation so far — its provider's thread/session either
 * doesn't exist or is stale — so we hand it the recent transcript as a note.
 *
 * Unlike buildForkHandoffNote this is not a new session; it is the *continuation*
 * of an existing one, so the wording tells the new engine to pick up seamlessly
 * rather than treating it as a branch.
 */
export function buildEngineSwitchHandoffNote(input: {
  fromModel?: string | null;
  targetModel?: string | null;
  sessionId?: string;
  reservedBytes?: number;
  requiredEntryId?: string;
  fromProvider: "claude" | "codex" | "pi" | "acp";
  toProvider: "claude" | "codex" | "pi" | "acp";
  /** True when the target engine is resuming its own earlier thread (Claude
   *  coming back to a session it ran before) — then it already remembers the
   *  turns up to the switch and only needs the other engine's turns since. */
  targetResuming?: boolean;
  /** Same engine, replacement session: the stored engine session could not
   *  be resumed (e.g. the run landed on a server whose DB doesn't hold it)
   *  and a fresh one replaced it — the model is unchanged but its internal
   *  conversation state is gone. */
  sameEngineRestart?: boolean;
  entries: TranscriptEntry[];
  maxEntries?: number;
  maxChars?: number;
}): string {
  const transcript = selectPortableHandoff({
    entries: input.entries,
    sessionId: input.sessionId,
    contextWindow: contextWindowFor(input.targetModel),
    reservedBytes: (input.reservedBytes ?? 0) + 4000,
    requiredEntryId: input.requiredEntryId,
    maxBytes: input.maxChars,
    maxEntries: input.maxEntries,
  });

  const fromLabel = input.fromModel
    ? `${input.fromModel} (${input.fromProvider})`
    : input.fromProvider;

  return [
    "## Engine handoff",
    input.sameEngineRestart
      ? `Your engine session in this ${productName()} conversation could not be resumed, so a fresh one replaced it mid-conversation. You are continuing the *same* session, not starting a new task.`
      : `This ${productName()} session was just switched mid-conversation from ${fromLabel} to you. You are continuing the *same* session, not starting a new task.`,
    input.sameEngineRestart
      ? "Your internal memory of the conversation was lost with the old engine session, so treat the transcript below as the conversation so far and continue seamlessly."
      : input.targetResuming
        ? "You resumed your own earlier thread in this session, so you remember the conversation up to the switch — the transcript below covers the turns the other engine ran in between, which you were not part of."
        : "The previous engine cannot transfer its internal conversation state to you, so treat the transcript below as the conversation so far and continue seamlessly.",
    transcript
      ? `Conversation transcript:\n${transcript}`
      : "No prior transcript entries were available.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
