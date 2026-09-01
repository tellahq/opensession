/**
 * opensession-todos — an in-process MCP server for the user's Desk todo list
 * (src/server/todos.ts). Wired into interactive runs only (interactive-mcp.ts)
 * so every session can capture follow-ups onto the user's list; automation
 * runs never see it (untrusted ticket text must not write to a human's list —
 * revisit as append-only alongside the daily-digest automation).
 *
 * Items carry their source session, so the Desk overlay can deep-link back to
 * the conversation that added them.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { timezoneForUser } from "../../server/shared/user-mappings";
import {
  addTodo,
  getTodo,
  listTodos,
  updateTodo,
  type TodoStatus,
} from "../../server/todos";

export interface TodosToolContext {
  sessionId?: string;
  /** Owner of the list — the run's user (first-name convention). */
  user: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmt(t: {
  id: string;
  text: string;
  status: string;
  note?: string;
  due?: string;
  remindAt?: string;
  createdAt: string;
}): string {
  const extras = [
    t.status !== "open" ? t.status : "",
    t.due ? `due ${t.due}` : "",
    t.remindAt ? `reminder ${t.remindAt}` : "",
    t.note ? `note: ${t.note}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `- [${t.id}] ${t.text}${extras ? ` (${extras})` : ""}`;
}

export function createTodosMcpServer(ctx: TodosToolContext) {
  // Baked into the tool descriptions so the model computes reminder times in
  // the list owner's local timezone (identity.team[].timezone).
  const tz = timezoneForUser(ctx.user);
  const tools = [
    tool(
      "add_todo",
      'Add an item to the user\'s personal todo list (their Desk). Use when the user says "remind me", "put on my list", "I want to finish X today" — or when this session produces a genuine follow-up the human must handle later (a decision to make, a PR to review, an unfinished thread). It is a curated list of the user\'s obligations, NOT an event log: don\'t add routine progress notes, and never add more than a couple of items per conversation unless asked.',
      {
        text: z
          .string()
          .describe("The todo, one concise line, phrased as an action."),
        note: z
          .string()
          .optional()
          .describe(
            "Optional one-line context/provenance (why it matters, a PR/ticket link).",
          ),
        due: z.string().optional().describe("Optional due date, YYYY-MM-DD."),
        remindAt: z
          .string()
          .optional()
          .describe(
            `Optional reminder as an ISO 8601 UTC datetime (e.g. 2026-07-22T07:00:00Z) — the user gets a push notification + Slack DM at that moment. Set it whenever they say things like "remind me tomorrow" or "tomorrow": compute from the current date in the user's timezone (${tz}), defaulting to 09:00 local when no time is given, then convert to UTC.`,
          ),
      },
      async (args: {
        text: string;
        note?: string;
        due?: string;
        remindAt?: string;
      }) => {
        try {
          const item = addTodo({
            user: ctx.user,
            text: args.text,
            note: args.note,
            due: args.due,
            remindAt: args.remindAt,
            source: {
              kind: "session",
              sessionId: ctx.sessionId,
              by: ctx.user,
            },
          });
          return text(`Added to ${ctx.user}'s list: ${fmt(item)}`);
        } catch (e: any) {
          return text(`Couldn't add todo: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "list_todos",
      "List the user's todo list (their Desk). Defaults to open items, newest first. Use before answering \"what's on my plate?\" and before adding something that might already be on the list.",
      {
        status: z
          .enum(["open", "done", "dropped", "all"])
          .optional()
          .describe("Filter by status (default open)."),
      },
      async (args: { status?: TodoStatus | "all" }) => {
        const items = listTodos({
          user: ctx.user,
          status: args.status || "open",
          limit: 50,
        });
        if (!items.length)
          return text(
            `No ${args.status && args.status !== "all" ? args.status : "open"} todos on ${ctx.user}'s list.`,
          );
        return text(items.map(fmt).join("\n"));
      },
    ),
    tool(
      "complete_todo",
      "Mark a todo done, by id (get ids from list_todos). Use when the user says they finished it, or when you verified the work is actually done (e.g. the PR merged).",
      {
        id: z.string().describe("The todo id (todo-…)."),
      },
      async (args: { id: string }) => {
        try {
          const item = updateTodo(args.id, { status: "done" }, ctx.user);
          return text(`Done: ${item.text}`);
        } catch (e: any) {
          return text(`Couldn't complete todo: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "drop_todo",
      "Drop a todo — the user consciously decided NOT to do it. Only on the user's explicit say-so; never drop items on your own judgment. Confirm intent first if there is any doubt.",
      {
        id: z.string().describe("The todo id (todo-…)."),
      },
      async (args: { id: string }) => {
        try {
          const item = updateTodo(args.id, { status: "dropped" }, ctx.user);
          return text(`Dropped: ${item.text}`);
        } catch (e: any) {
          return text(`Couldn't drop todo: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "update_todo",
      'Edit a todo\'s text, note, or due date, or reopen a done/dropped one (status "open").',
      {
        id: z.string().describe("The todo id (todo-…)."),
        text: z.string().optional().describe("New text."),
        note: z
          .string()
          .optional()
          .describe("New context note ('' clears it)."),
        due: z
          .string()
          .optional()
          .describe("New due date YYYY-MM-DD ('' clears it)."),
        remindAt: z
          .string()
          .optional()
          .describe(
            `New reminder, ISO 8601 UTC datetime ('' clears it; compute from the user's timezone, ${tz}). Rescheduling makes it fire again.`,
          ),
        status: z
          .enum(["open", "done", "dropped"])
          .optional()
          .describe('New status (e.g. reopen with "open").'),
      },
      async (args: {
        id: string;
        text?: string;
        note?: string;
        due?: string;
        remindAt?: string;
        status?: TodoStatus;
      }) => {
        try {
          if (!getTodo(args.id)) return text(`Unknown todo "${args.id}".`);
          const item = updateTodo(
            args.id,
            {
              text: args.text,
              note: args.note === "" ? null : args.note,
              due: args.due === "" ? null : args.due,
              remindAt: args.remindAt === "" ? null : args.remindAt,
              status: args.status,
            },
            ctx.user,
          );
          return text(`Updated: ${fmt(item)}`);
        } catch (e: any) {
          return text(`Couldn't update todo: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-todos",
    version: "1.0.0",
    tools,
  });
}
