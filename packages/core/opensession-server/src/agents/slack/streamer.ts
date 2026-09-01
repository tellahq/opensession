/**
 * SlackStreamer — streams AI responses to Slack with graceful fallback.
 *
 * Uses Slack's chat.startStream / chat.appendStream / chat.stopStream APIs
 * for real-time streaming in DMs. Falls back to regular messages if streaming
 * is unavailable.
 */

import {
  slackApiCall,
  sendSlackMessage,
  updateSlackMessage,
  postSlackBlocks,
  postSlackFiles,
} from "./slack-api";
import { slackTeamId } from "./state";
import { extractBlocks } from "./blocks";
import {
  describeSkippedMedia,
  type SlackMedia,
  type SkippedMedia,
} from "./media";

// ---------------------------------------------------------------------------
// Tool status helpers
// ---------------------------------------------------------------------------

/** Tools that should NOT trigger a status update (read-only / internal) */
const SILENT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "TodoRead",
  "LSP",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
]);

/** Extract just the filename from a full path */
function shortPath(filePath: string): string {
  if (!filePath) return "file";
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/** The path an edit or write names. Engines disagree on the spelling, and a
 *  status that misses it degrades to a bare "Editing file". */
function inputPath(input: any): string {
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "notebook_path",
    "notebookPath",
  ]) {
    const value = input?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Build a short status string for a tool call */
export function buildToolStatus(toolName: string, input: any): string {
  if (toolName === "Edit") return `Editing ${shortPath(inputPath(input))}`;
  if (toolName === "Write") return `Writing ${shortPath(inputPath(input))}`;
  if (toolName === "NotebookEdit")
    return `Editing ${shortPath(inputPath(input))}`;
  if (toolName === "Bash") {
    const desc = input?.description;
    if (desc) return desc;
    const cmd = (input?.command || "").substring(0, 60);
    return `Running ${cmd}${(input?.command || "").length > 60 ? "\u2026" : ""}`;
  }
  if (toolName === "Task") return input?.description || "Running subtask";
  if (toolName === "Skill") return `Running /${input?.skill || "skill"}`;
  return `Using ${toolName}`;
}

/** Check if a tool is silent (should not trigger status updates) */
export function isSilentTool(toolName: string): boolean {
  return SILENT_TOOLS.has(toolName);
}

// ---------------------------------------------------------------------------
// SlackStreamer class
// ---------------------------------------------------------------------------

export class SlackStreamer {
  private channel: string;
  private threadTs: string | undefined;
  private userId: string;
  private streamMessageTs: string | null = null;
  private streamStarted = false;
  private useStreaming = true;
  private fallbackTs: string | null = null;

  constructor(channel: string, threadTs: string | undefined, userId: string) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.userId = userId;
  }

  /** Update the assistant thread status (shown as thinking/typing indicator) */
  async setStatus(status: string): Promise<void> {
    if (!this.channel.startsWith("D")) return;
    if (!this.threadTs) return;
    await slackApiCall("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status,
    });
  }

  /** Lazily start the stream on first content — avoids empty message */
  private async ensureStream(): Promise<void> {
    if (this.streamStarted) return;
    this.streamStarted = true;

    const params: Record<string, any> = {
      channel: this.channel,
      thread_ts: this.threadTs,
    };
    if (slackTeamId) params.recipient_team_id = slackTeamId;
    if (this.userId) params.recipient_user_id = this.userId;

    const resp = await slackApiCall("chat.startStream", params);
    if (resp.ok && resp.ts) {
      this.streamMessageTs = resp.ts;
      this.useStreaming = true;
    } else {
      console.log(
        `[slack] Streaming unavailable (${resp.error || "unknown"}), using fallback`,
      );
      this.useStreaming = false;
      const msg = await sendSlackMessage(
        this.channel,
        "Thinking...",
        this.threadTs,
      );
      this.fallbackTs = msg?.ts || null;
    }
  }

  /** Stream a chunk of markdown text */
  async appendText(text: string): Promise<void> {
    await this.ensureStream();
    if (!this.useStreaming || !this.streamMessageTs) return;
    await slackApiCall("chat.appendStream", {
      channel: this.channel,
      ts: this.streamMessageTs,
      chunks: [{ type: "markdown_text", text }],
    });
  }

  /**
   * Finalize the stream with the result text, plus any media the reply asked
   * to show (see media.ts — the caller splits it off before the text is
   * converted and capped, so the paths survive both).
   */
  async stop(
    resultText: string,
    attachments?: { media: SlackMedia[]; skipped?: SkippedMedia[] },
  ): Promise<void> {
    const { cleanedText, blocks } = extractBlocks(resultText);
    // If every paragraph was a block, streaming still needs *some* text.
    const streamText = cleanedText || (blocks.length > 0 ? " " : resultText);
    // A reply whose whole content was a media marker leaves nothing to post,
    // and a message of one space is a visible empty bubble above the upload.
    // A stream that already exists still has to be closed with something.
    const mediaOnly =
      streamText.trim().length === 0 && (attachments?.media.length ?? 0) > 0;

    if (this.useStreaming && this.streamMessageTs) {
      await slackApiCall("chat.stopStream", {
        channel: this.channel,
        ts: this.streamMessageTs,
        chunks: [{ type: "markdown_text", text: streamText || " " }],
      });
      this.streamMessageTs = null;
    } else if (this.fallbackTs) {
      await updateSlackMessage(
        this.channel,
        this.fallbackTs,
        streamText || " ",
      );
      this.fallbackTs = null;
    } else if (!mediaOnly) {
      await sendSlackMessage(this.channel, streamText, this.threadTs);
    }

    // Slack requires one table per message, so post each extracted block
    // as its own follow-up to preserve document order.
    for (const { block, type } of blocks) {
      const fallback =
        type === "table" ? "(table)" : block?.text?.text || "(alert)";
      try {
        await postSlackBlocks(this.channel, fallback, [block], this.threadTs);
      } catch (e) {
        console.warn(`[slack] Failed to post ${type} block:`, e);
      }
    }

    await this.postMedia(attachments?.media || [], attachments?.skipped || []);
  }

  /**
   * Upload the reply's marked media into the thread, as one share so a
   * before/after pair stays together.
   *
   * Anything we couldn't send gets named. A marker that silently produces
   * nothing is the failure this whole path exists to fix: the agent believes
   * it showed you the screenshot either way.
   */
  private async postMedia(
    media: SlackMedia[],
    skipped: SkippedMedia[],
  ): Promise<void> {
    const unsent = [...skipped];
    if (media.length > 0) {
      try {
        await postSlackFiles(
          this.channel,
          media.map((item) => item.path),
          "",
          { threadTs: this.threadTs },
        );
      } catch (e) {
        console.warn("[slack] Failed to upload response media:", e);
        for (const item of media) {
          unsent.push({ path: item.path, reason: "the upload failed" });
        }
      }
    }
    if (unsent.length === 0) return;
    try {
      await sendSlackMessage(
        this.channel,
        `Couldn't attach ${describeSkippedMedia(unsent)}.`,
        this.threadTs,
      );
    } catch (e) {
      console.warn("[slack] Failed to report unsent media:", e);
    }
  }

  /** Send an error and finalize */
  async error(errorText: string): Promise<void> {
    await this.stop(errorText);
  }

  /** Clear the assistant thread status */
  async clearStatus(): Promise<void> {
    if (!this.channel.startsWith("D")) return;
    if (!this.threadTs) return;
    await slackApiCall("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status: "",
    });
  }
}
