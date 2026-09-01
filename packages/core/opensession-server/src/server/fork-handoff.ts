import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import { productName } from "./config";
import type { TranscriptEntry } from "./types";

function clip(text: string, max = 1200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function roleLabel(type: TranscriptEntry["type"]): string {
  switch (type) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool_use":
      return "Tool";
    case "tool_result":
      return "Tool result";
  }
}

export function buildForkHandoffNote(input: {
  sourceId: string;
  sourceTitle?: string | null;
  sourceModel?: string | null;
  messageId?: string;
  entries: TranscriptEntry[];
  maxEntries?: number;
}): string {
  const maxEntries = input.maxEntries ?? 12;
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

  const useful = entries
    .filter(
      (e) =>
        ["user", "assistant", "system"].includes(e.type) &&
        !isContextInjection(e),
    )
    .slice(-maxEntries);
  const lines = useful.map((e) => `- ${roleLabel(e.type)}: ${clip(e.content)}`);

  return [
    "## Fork handoff",
    `This is a new engine thread forked from ${productName()} session ${input.sourceId} at ${boundary}.`,
    input.sourceTitle ? `Source title: ${input.sourceTitle}` : undefined,
    input.sourceModel ? `Source model: ${input.sourceModel}` : undefined,
    "The original engine cannot clone its internal conversation state here, so use this transcript handoff as context and continue the requested work in this new session.",
    lines.length
      ? `Recent source transcript:\n${lines.join("\n")}`
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
  maxEntriesPerSession = 30,
): string {
  const sections = sessions.map((session) => {
    const useful = session.entries
      .filter(
        (e) =>
          ["user", "assistant", "system"].includes(e.type) &&
          !isContextInjection(e),
      )
      .slice(-maxEntriesPerSession);
    const lines = useful.map(
      (e) => `- ${roleLabel(e.type)}: ${clip(e.content, 700)}`,
    );
    const head = `### ${session.title || "Untitled session"} — @session:${session.id}${session.model ? ` (${session.model})` : ""}`;
    return `${head}\n${lines.length ? lines.join("\n") : "(no transcript yet)"}`;
  });

  return [
    "## Attached session transcripts",
    "The user attached transcripts of other sessions from this workspace as background context for this conversation. They are reference material from parallel conversations — the user's own message is the actual instruction. Excerpts are truncated; for the full history of any of them, use the opensession-sessions `get_session` tool with the session id shown.",
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
  fromProvider: "claude" | "codex" | "pi";
  toProvider: "claude" | "codex" | "pi";
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
  const maxChars = input.maxChars ?? 180_000;
  // An injection record is the harness's own audit row, not conversation:
  // folding it into a handoff would re-inject a payload the new engine is
  // about to be handed anyway, and grow it on every restart.
  const entries = input.entries.filter((e) => !isContextInjection(e));
  const conversational = input.sameEngineRestart
    ? entries
    : entries.filter((e) => ["user", "assistant", "system"].includes(e.type));
  const useful =
    input.maxEntries !== undefined
      ? conversational.slice(-input.maxEntries)
      : conversational;
  const candidates = useful.map(
    (e) => `- ${roleLabel(e.type)}: ${clip(e.content, 8_000)}`,
  );
  const lines: string[] = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const line = candidates[i];
    if (lines.length && chars + line.length + 1 > maxChars) break;
    lines.unshift(line.slice(0, maxChars));
    chars += line.length + 1;
  }
  if (lines.length < candidates.length) {
    lines.unshift(
      "- System: Earlier conversation omitted because the engine handoff reached its context budget.",
    );
  }

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
    lines.length
      ? `Conversation transcript:\n${lines.join("\n")}`
      : "No prior transcript entries were available.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
