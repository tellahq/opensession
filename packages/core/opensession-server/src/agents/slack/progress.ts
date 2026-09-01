/**
 * SlackProgress — the live "Working…" card for a run, rendered as a native
 * Slack task_card block (the same card Linear's agent uses), edited in place
 * via chat.update.
 *
 * Message layout while running:
 *   [section]   Created and started working on <session link>, or notes that a
 *               follow-up comment was added to an existing session
 *   [task_card] title + spinner; latest assistant narration and a capped
 *               checklist in `details`; current tool action in `output`
 *   [actions]   lone Stop button
 * On finish the card collapses to title + terminal status (complete/error),
 * the way Linear's agent leaves a thread.
 *
 * Design (unchanged from the pre-task_card card):
 *   - One message, edited in place — never a stream of new posts.
 *   - Updates happen at semantic boundaries (a step starts/completes, a tool
 *     runs, a narration paragraph lands), NOT per token.
 *   - Edits are throttled to ~1/sec because Slack soft-limits chat.update to
 *     roughly one call per second per channel; bursting causes the very lag
 *     and stutter we're trying to remove.
 */

import { postSlackBlocks, updateSlackBlocks } from "./slack-api";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface ProgressTodo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface SlackProgressOpts {
  channel: string;
  sessionKey: string;
  /** Open Session URL for this session — the header link target. */
  sessionUrl: string;
  /** Plain-text work title for the card (from the opening ask). */
  title: string;
  /** Display text of the header link, e.g. the session branch. */
  linkText: string;
  /** Teammate whose follow-up comment is continuing an existing session. */
  continuedBy?: string;
}

/** Slack soft-limits chat.update to ~1/sec/channel. Stay just above that. */
const MIN_EDIT_INTERVAL_MS = 1100;

/** Linear keeps the card short — cap the visible checklist to a small window. */
const MAX_TODO_LINES = 4;
const MAX_NARRATION_CHARS = 280;
const MAX_CODE_CHARS = 120;

/** First usable line of the opening prompt as a plain-text card title. */
export function taskCardTitle(prompt: string): string {
  const line =
    (prompt || "")
      .replace(/<@[A-Z0-9]+>/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "Working on it";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function progressHeaderText(
  opts: Pick<SlackProgressOpts, "sessionUrl" | "linkText" | "continuedBy">,
  linked = true,
): string {
  const session = linked
    ? `<${opts.sessionUrl}|${escapeMrkdwn(opts.linkText)}>`
    : opts.sessionUrl;
  return opts.continuedBy
    ? `${escapeMrkdwn(opts.continuedBy)} added a comment to ${session}`
    : `Created and started working on ${session}`;
}

export class SlackProgress {
  private o: SlackProgressOpts;
  private ts: string | null = null;
  /** task_card block_id must be fresh on every edit of the message. */
  private iter = 0;

  private todos: ProgressTodo[] = [];
  private action: { text: string; code?: string } | null = null;
  /** Accumulated assistant prose; the card shows the last paragraph. */
  private narration = "";

  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** In-flight edit, so finish() can wait for it and avoid a stale overwrite. */
  private inflight: Promise<void> | null = null;

  constructor(opts: SlackProgressOpts) {
    this.o = opts;
  }

  private headerText(linked = true): string {
    return progressHeaderText(this.o, linked);
  }

  /**
   * Post the initial card. The channel sees a visible reply immediately; this
   * object then edits that same message in place as work proceeds. A failed
   * post disables the card (the run itself is unaffected).
   */
  async start(threadTs?: string): Promise<void> {
    try {
      const res = await postSlackBlocks(
        this.o.channel,
        this.headerText(false),
        this.runningBlocks(),
        threadTs,
        { unfurlLinks: false, unfurlMedia: false },
      );
      if (res?.ok && res.ts) this.ts = res.ts;
      else console.warn("[slack] progress card post failed:", res?.error);
    } catch (e) {
      console.warn("[slack] progress card post failed:", e);
    }
    // Don't immediately re-edit the fresh card — let the throttle window pass.
    this.lastEditAt = Date.now();
  }

  /** Replace the checklist from a TodoWrite tool call. */
  setTodos(todos: ProgressTodo[] | undefined): void {
    if (!Array.isArray(todos)) return;
    this.todos = todos;
    this.narrationBreak();
    this.schedule();
  }

  /** Set the current activity line (from a tool call / TaskCreate). `code`
   *  renders monospaced under it, e.g. the bash command being run. */
  setAction(text: string | undefined, code?: string): void {
    if (!text) return;
    const c = code?.trim();
    this.action = {
      text,
      code: c
        ? c.length > MAX_CODE_CHARS
          ? `${c.slice(0, MAX_CODE_CHARS - 1)}…`
          : c
        : undefined,
    };
    this.narrationBreak();
    this.schedule();
  }

  /** Feed streamed assistant text; the card shows the latest paragraph. */
  appendNarration(text: string): void {
    if (!text) return;
    this.narration += text;
    // Keep the buffer bounded — only the tail is ever rendered.
    if (this.narration.length > 20000) {
      this.narration = this.narration.slice(-10000);
    }
    this.schedule();
  }

  /** A tool call ends the current prose paragraph even without a blank line. */
  private narrationBreak(): void {
    if (this.narration && !this.narration.endsWith("\n\n")) {
      this.narration += "\n\n";
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private header(): any {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: this.headerText(),
      },
    };
  }

  private stopRow(): any {
    return {
      type: "actions",
      block_id: `stop-${this.o.sessionKey}-${this.iter}`,
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":octagonal_sign: Stop",
            emoji: true,
          },
          style: "danger",
          action_id: `stop:${this.o.sessionKey}`,
          value: this.o.sessionKey,
        },
      ],
    };
  }

  private lastNarrationParagraph(): string | null {
    const paras = this.narration
      .split(/\n{2,}/)
      .map((p) =>
        p
          .replace(/```[\s\S]*?```/g, "")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/[*`]+/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((p) => p.length >= 2);
    const last = paras[paras.length - 1];
    if (!last) return null;
    return last.length > MAX_NARRATION_CHARS
      ? `…${last.slice(-(MAX_NARRATION_CHARS - 1))}`
      : last;
  }

  /** A small window of the checklist around the in-progress step. */
  private visibleTodos(): { items: ProgressTodo[]; note: string | null } {
    if (this.todos.length <= MAX_TODO_LINES) {
      return { items: this.todos, note: null };
    }
    let idx = this.todos.findIndex((t) => t.status !== "completed");
    if (idx < 0) idx = this.todos.length - 1;
    const start = Math.max(
      0,
      Math.min(idx - 1, this.todos.length - MAX_TODO_LINES),
    );
    const done = this.todos.filter((t) => t.status === "completed").length;
    return {
      items: this.todos.slice(start, start + MAX_TODO_LINES),
      note: `${done} of ${this.todos.length} steps done`,
    };
  }

  private detailElements(): any[] {
    const els: any[] = [];
    const para = this.lastNarrationParagraph();
    if (para) {
      els.push({
        type: "rich_text_section",
        elements: [{ type: "text", text: para }],
      });
    }
    if (this.todos.length) {
      const { items, note } = this.visibleTodos();
      els.push({
        type: "rich_text_list",
        style: "bullet",
        elements: items.map((t) => {
          const label =
            (t.status === "in_progress"
              ? t.activeForm?.trim() || t.content?.trim()
              : t.content?.trim()) || "(step)";
          const style =
            t.status === "completed"
              ? { strike: true }
              : t.status === "in_progress"
                ? { bold: true }
                : undefined;
          return {
            type: "rich_text_section",
            elements: [
              { type: "text", text: label, ...(style ? { style } : {}) },
            ],
          };
        }),
      });
      if (note) {
        els.push({
          type: "rich_text_section",
          elements: [{ type: "text", text: note, style: { italic: true } }],
        });
      }
    }
    return els;
  }

  private outputElements(): any[] {
    if (!this.action) return [];
    const els: any[] = [{ type: "text", text: this.action.text }];
    if (this.action.code) {
      els.push({ type: "text", text: "\n" });
      els.push({
        type: "text",
        text: this.action.code,
        style: { code: true },
      });
    }
    return [{ type: "rich_text_section", elements: els }];
  }

  private taskCard(status: "in_progress" | "complete" | "error"): any {
    const card: any = {
      type: "task_card",
      task_id: `task-${this.o.sessionKey}`,
      block_id: `task-${this.o.sessionKey}-${this.iter}`,
      title: this.o.title,
      status,
    };
    // Finished cards collapse to title + terminal status, like Linear's.
    if (status !== "in_progress") return card;
    const details = this.detailElements();
    if (details.length) card.details = { type: "rich_text", elements: details };
    const output = this.outputElements();
    if (output.length) card.output = { type: "rich_text", elements: output };
    return card;
  }

  private runningBlocks(): any[] {
    this.iter++;
    return [this.header(), this.taskCard("in_progress"), this.stopRow()];
  }

  private finishBlocks(label: string): any[] {
    this.iter++;
    const blocks: any[] = [
      this.header(),
      this.taskCard(label === "Done" ? "complete" : "error"),
    ];
    if (label !== "Done") {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_${label}_` }],
      });
    }
    return blocks;
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.finished || !this.ts) return;
    const wait = this.lastEditAt + MIN_EDIT_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    // Coalesce: a single trailing edit captures whatever the latest state is.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, wait);
    }
  }

  private async flush(): Promise<void> {
    if (this.finished || !this.ts) return;
    this.lastEditAt = Date.now();
    const ts = this.ts;
    this.inflight = (async () => {
      try {
        const res = await updateSlackBlocks(
          this.o.channel,
          ts,
          "Working…",
          this.runningBlocks(),
          { unfurlLinks: false, unfurlMedia: false },
        );
        if (res && !res.ok) {
          console.warn("[slack] progress flush failed:", res.error);
        }
      } catch (e) {
        console.warn("[slack] progress flush failed:", e);
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Stop updating and render the terminal state of the card: title + status
   * (complete for "Done", error otherwise), the header link staying in place.
   */
  async finish(label: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let any in-flight running-state edit land first, so our terminal render
    // isn't immediately overwritten by a stale update.
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* already logged */
      }
    }
    if (!this.ts) return;
    try {
      const res = await updateSlackBlocks(
        this.o.channel,
        this.ts,
        label,
        this.finishBlocks(label),
        { unfurlLinks: false, unfurlMedia: false },
      );
      if (res && !res.ok) {
        console.warn("[slack] progress finish failed:", res.error);
      }
    } catch (e) {
      console.warn("[slack] progress finish failed:", e);
    }
    this.ts = null;
  }

  /** A process restart is temporary, not an error or user cancellation. Keep
   * the card visibly in-progress but remove its now-dead Stop button. */
  async restarting(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* already logged */
      }
    }
    if (!this.ts) return;
    try {
      const res = await updateSlackBlocks(
        this.o.channel,
        this.ts,
        "Restarting…",
        [
          this.header(),
          this.taskCard("in_progress"),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "_Open Session is restarting. Continuing shortly._",
              },
            ],
          },
        ],
        { unfurlLinks: false, unfurlMedia: false },
      );
      if (res && !res.ok) {
        console.warn("[slack] progress restart render failed:", res.error);
      }
    } catch (e) {
      console.warn("[slack] progress restart render failed:", e);
    }
    this.ts = null;
  }
}
