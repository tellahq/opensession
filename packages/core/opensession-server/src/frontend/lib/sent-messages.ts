import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { toolCommand } from "@tellahq/opensession-protocol/tool-presentation";
import { z } from "zod";
import type { TranscriptEntry } from "./types";

/**
 * The messages a person typed into a session, in order: the index behind the
 * transcript's message rail.
 *
 * "A message" is whatever the transcript renders as one, so the three tests
 * here mirror MessageBubble's: a `user` entry, not classified as an
 * operational notice, carrying a body or an attachment. An entry it draws
 * nothing for (delivery plumbing whose body was fenced context) has no bubble
 * to scroll to, and a rail tick pointing at nothing is worse than no tick.
 *
 * Each message also carries what came of it: the agent's closing words for
 * that turn, and what the turn produced. Both are read from the entries
 * between this message and the next one. That is what makes the rail's preview
 * card worth opening, because the question on its own is rarely what someone
 * scrolling back is looking for. They are recognising a moment, and the moment
 * is the question plus its answer.
 */

/** What a turn produced, when its tool calls say so plainly. */
export interface SentOutcome {
  kind: "pr" | "commit" | "edit";
  label: string;
}

/** One sent message, as the rail indexes it. */
export interface SentMessage {
  /** The rendered bubble's `data-eid`, which is what the rail scrolls to. */
  id: string;
  /** One flat line of the message, for the card's title. */
  preview: string;
  /** The last thing the agent said in this turn, flattened. */
  reply?: string;
  outcome?: SentOutcome;
  /** Set when a teammate sent this turn rather than the session's driver. */
  sender?: string;
  timestamp: string;
}

/** Enough for a wide row; the rest is the card's own truncation. Clamped here
 *  as well so a pasted 80KB message doesn't ride into the popup as one. */
const MAX_PREVIEW = 120;
/** The reply is a supporting line under the message, so it takes about twice
 *  the room and no more. */
const MAX_REPLY = 260;
/** How much of a reply is read before flattening it. An answer runs to tens of
 *  kilobytes and there are hundreds of them in a session; the preview only
 *  ever comes from the opening lines. */
const REPLY_SCAN = 1200;

/** A turn that did several things names the biggest one. */
const OUTCOME_RANK: Record<SentOutcome["kind"], number> = {
  pr: 3,
  commit: 2,
  edit: 1,
};

const commandInputSchema = z.looseObject({});

/** Collapse markdown into one readable run of prose. */
function flatten(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  // Break on a word so the ellipsis doesn't cut mid-token.
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Cut a slice at an unclosed code fence: `flatten` only strips matched pairs,
 *  so a reply sliced mid-fence would otherwise arrive with its backticks. */
function dropOpenFence(text: string): string {
  const fences = text.match(/```/g)?.length ?? 0;
  return fences % 2 ? text.slice(0, text.lastIndexOf("```")) : text;
}

/**
 * A staged transcript selection leads the message as blockquote lines
 * (lib/quotes.ts). That is what you were talking ABOUT, not what you said, so
 * the preview starts after it, unless quoting was the whole message.
 */
function dropLeadingQuote(text: string): string {
  const lines = text.split("\n");
  let at = 0;
  while (at < lines.length && (lines[at].startsWith(">") || !lines[at].trim()))
    at++;
  return lines.slice(at).join("\n").trim() || text;
}

/** What a message with no words of its own is: its attachments. */
function attachmentLabel(entry: TranscriptEntry): string {
  const files = entry.files ?? [];
  if (files.length === 1) return files[0].name;
  if (files.length > 1) return `${files.length} files`;
  const videos = entry.videos?.length ?? 0;
  if (videos) return videos === 1 ? "Video" : `${videos} videos`;
  const images = entry.images?.length ?? 0;
  if (images) return images === 1 ? "Image" : `${images} images`;
  return "";
}

/**
 * The artifact a command left behind. Only the two that are unmistakable from
 * the command itself: guessing at a third would put a confident wrong label on
 * a card whose whole job is recognition.
 */
function commandOutcome(command: string): SentOutcome | null {
  if (/\bgh\s+pr\s+create\b/.test(command))
    return { kind: "pr", label: "Pull request" };
  if (/\bgit\s+commit\b/.test(command))
    return { kind: "commit", label: "Commit" };
  return null;
}

export function collectSentMessages(entries: TranscriptEntry[]): SentMessage[] {
  const sent: SentMessage[] = [];
  let open: SentMessage | null = null;
  /** The turn's last assistant text, kept raw: flattening every one of them
   *  would flatten the whole session to keep the last of each turn. */
  let reply = "";
  let edited = new Set<string>();

  const closeTurn = () => {
    if (open) {
      const text = reply
        ? clamp(flatten(dropOpenFence(reply.slice(0, REPLY_SCAN))), MAX_REPLY)
        : "";
      if (text) open.reply = text;
      if (!open.outcome && edited.size)
        open.outcome = {
          kind: "edit",
          label:
            edited.size === 1 ? "Edited 1 file" : `Edited ${edited.size} files`,
        };
    }
    open = null;
    reply = "";
    edited = new Set();
  };

  const noteTool = (entry: TranscriptEntry) => {
    const turn = open;
    if (!turn) return;
    const tool = entry.presentation;
    if (tool?.family === "edit") {
      if (tool.detail.kind === "path") edited.add(tool.detail.path);
      else if (tool.detail.kind === "paths")
        for (const path of tool.detail.paths) edited.add(path);
      return;
    }
    // The input, not the presentation: that one is truncated to the 160
    // characters its row can show, and a `git commit` at the end of a long
    // script is exactly the case worth naming.
    const input = commandInputSchema.safeParse(entry.toolInput);
    const command =
      (input.success ? toolCommand(input.data) : "") ||
      (tool?.detail.kind === "command" ? tool.detail.command : "");
    if (!command) return;
    const found = commandOutcome(command);
    if (
      found &&
      (!turn.outcome ||
        OUTCOME_RANK[found.kind] > OUTCOME_RANK[turn.outcome.kind])
    )
      turn.outcome = found;
  };

  for (const raw of entries) {
    if (raw.type === "assistant") {
      if (open && raw.content.trim()) reply = raw.content;
      continue;
    }
    if (raw.type === "tool_use") {
      noteTool(raw);
      continue;
    }
    if (raw.type !== "user") continue;
    // Classification strips the "[Name] " delivery prefix and names the
    // sender, so both the preview and the attribution come from it rather
    // than from a second reading of the raw content.
    const entry = classifyEntry(raw);
    if (entry.notice) continue;
    const text = entry.content ? flatten(dropLeadingQuote(entry.content)) : "";
    const preview = text ? clamp(text, MAX_PREVIEW) : attachmentLabel(entry);
    if (!preview) continue;
    // A turn ends where the next message begins, and only there: a restart
    // notice or a routed status line lands mid-turn, and closing on one
    // would take the answer away from the question that asked for it.
    closeTurn();
    open = {
      id: entry.id,
      preview,
      timestamp: entry.timestamp,
    };
    if (entry.sender) open.sender = entry.sender;
    sent.push(open);
  }
  closeTurn();
  return sent;
}
