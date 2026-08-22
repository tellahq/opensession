/**
 * opensession-admin — an in-process MCP server that lets the agent manage its own
 * setup conversationally from Slack: automations (routines), MCP connections,
 * and channel memory.
 *
 * This server is created per interactive Slack message in handlers.ts and added
 * to the query()'s mcpServers. Because the tool handlers run in the parent
 * opensession process, they call the same automations.ts / connections.ts modules
 * the scheduler and HTTP API use — so changes are picked up immediately (the
 * scheduler re-reads disk every tick; MCP config is read fresh per run).
 *
 * Gating: it is ONLY wired into interactive Slack runs (never automation runs,
 * which never go through handlers.processMessage). The powerful automation/MCP
 * tools are further gated to the trusted user via `isAdmin`; channel-memory
 * tools are available to anyone who can talk to the bot.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomation,
} from "../../server/automations";
import {
  readMcpConfig,
  addMcpServer,
  removeMcpServer,
  setMcpAllowedUsers,
} from "../../server/connections";
import {
  addMemory,
  listMemory,
  forgetMemory,
  type MemoryContext,
  type MemoryEntry,
} from "./memory";
import { parseWhen } from "./parse-when";
import { configuredRepos, defaultRepo, personaName } from "../../server/config";

export interface AdminToolContext extends MemoryContext {
  /** Display name credited as the author of memories/automations. */
  createdBy: string;
  /** Trusted user — gates automation + MCP management tools. */
  isAdmin: boolean;
  /**
   * Slack thread anchor (thread_ts) of the originating message, when this runs
   * from a Slack thread. Lets schedule_once post a reminder back into "this"
   * thread. Absent in Open Session sessions (no Slack thread).
   */
  threadTs?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** The instance's default repo id, or "" when nothing is registered. The repo
 * tools describe themselves against the live registry rather than a hardcoded
 * list, so a newly added checkout is offerable straight away. */
function defaultRepoId(): string {
  try {
    return defaultRepo().id;
  } catch {
    return "";
  }
}

/** Description shared by the create/update `repo` params. An automation with
 * no repo runs against the instance default, which is rarely what the caller
 * meant when they asked for one somewhere else. */
function repoParamHelp(): string {
  const ids = Object.keys(configuredRepos());
  const fallback = defaultRepoId();
  return (
    "Which registered repository the automation works in" +
    (ids.length ? `. One of: ${ids.join(", ")}` : "") +
    (fallback ? `. Omit to use the instance default (${fallback})` : "") +
    "."
  );
}

function fmtEntry(e: MemoryEntry): string {
  return `• [${e.id}] ${e.text}  _(${e.by})_`;
}

export function createAdminMcpServer(ctx: AdminToolContext) {
  const memCtx: MemoryContext = {
    channel: ctx.channel,
    userId: ctx.userId,
    isDM: ctx.isDM,
    isPrivate: ctx.isPrivate,
  };

  const tools: any[] = [
    // -----------------------------------------------------------------------
    // Channel memory (available to anyone who can talk to the bot)
    // -----------------------------------------------------------------------
    tool(
      "remember",
      "Save a fact, preference, or standing instruction to this channel's memory so you recall it in future threads. In a public channel this is shared workspace-wide; in a private channel or DM it stays local. Use when the user says 'remember…' or states a durable preference.",
      { text: z.string().describe("The fact or instruction to remember.") },
      async (args: { text: string }) => {
        if (!args.text?.trim()) return text("Nothing to remember (empty text).");
        const e = await addMemory(memCtx, args.text, ctx.createdBy);
        return text(`Got it — remembered (id \`${e.id}\`).`);
      }
    ),
    tool(
      "list_memory",
      "List what you currently remember for this channel/DM, including shared workspace memory. Returns entry ids you can pass to forget.",
      {},
      async () => {
        const v = await listMemory(memCtx);
        if (!v.local.length && !v.shared.length) {
          return text("I don't have any memory for this channel yet.");
        }
        const parts: string[] = [];
        if (v.local.length) {
          parts.push(
            (v.localIsWorkspace ? "*Workspace memory:*" : "*This channel:*") +
              "\n" +
              v.local.map(fmtEntry).join("\n")
          );
        }
        if (v.shared.length) {
          parts.push(
            "*Workspace memory (shared, read-only here):*\n" +
              v.shared.map(fmtEntry).join("\n")
          );
        }
        return text(parts.join("\n\n"));
      }
    ),
    tool(
      "forget",
      "Forget a remembered entry by its id (from list_memory).",
      { id: z.string().describe("The entry id to forget, e.g. 'a1b2c3d4'.") },
      async (args: { id: string }) => {
        const r = await forgetMemory(memCtx, args.id);
        return text(r.ok ? `Forgot: "${r.removed.text}".` : r.error);
      }
    ),
  ];

  if (ctx.isAdmin) {
    tools.push(
      // ---------------------------------------------------------------------
      // Automations (routines)
      // ---------------------------------------------------------------------
      tool(
        "list_automations",
        `List all of ${personaName()}'s automations (routines): scheduled, event- and webhook-triggered jobs.`,
        {},
        async () => {
          const all = listAutomations();
          if (!all.length) return text("No automations configured.");
          const fallbackRepo = defaultRepoId();
          const lines = all.map((a) => {
            const trig = a.runOnceAt
              ? `once at ${a.runOnceAt}`
              : a.schedule
                ? `cron \`${a.schedule}\` (UTC)`
                : a.eventKey
                  ? `event \`${a.eventKey}\``
                  : "manual/webhook";
            const next = a.nextRunAt ? `, next ${a.nextRunAt}` : "";
            const last = a.lastRunStatus ? `, last ${a.lastRunStatus}` : "";
            const runsIn = a.repo || fallbackRepo;
            const repo = runsIn ? `, ${runsIn}` : "";
            return `• *${a.name}* [\`${a.id}\`]: ${trig}, ${a.mode}${repo}, ${a.enabled ? "enabled" : "disabled"}${next}${last}`;
          });
          return text(lines.join("\n"));
        }
      ),
      tool(
        "create_automation",
        "Create a new automation (routine). Provide a clear prompt describing the task. Set `repo` to the repository it works in, or it runs against the instance default. Use a 5-field UTC cron `schedule` for recurring jobs (omit for manual/webhook only). Pick mode 'ask' for read-only or 'code' if it must edit files / open PRs. Optionally restrict tools with mcpServers and set a model.",
        {
          name: z.string().describe("Short display name."),
          prompt: z
            .string()
            .describe("The task instructions the automation runs each time."),
          schedule: z
            .string()
            .optional()
            .describe(
              "5-field UTC cron, e.g. '0 16 * * 1-5' = 9am PT weekdays. Omit for manual/webhook only. Note: server is UTC."
            ),
          mode: z
            .enum(["ask", "code"])
            .optional()
            .describe("'ask' = read-only (default), 'code' = worktree + can open PRs."),
          repo: z.string().optional().describe(repoParamHelp()),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe("Optional allowlist of MCP server names this run may use."),
          model: z
            .string()
            .optional()
            .describe(
              "Optional model id — a tier ('claude-opus-5', 'gpt-5.6-sol') or an engine-prefixed id ('pi/anthropic/claude-opus-5')."
            ),
          accountId: z
            .string()
            .optional()
            .describe(
              "Optional claude-accounts id to pin runs to one subscription. By default a hard pin (cost cap: exhaustion falls to the fallback model, never the shared pool)."
            ),
          accountStrict: z
            .boolean()
            .optional()
            .describe(
              "false = soft pin: prefer the pinned account but fall back to the shared pool when it's exhausted. Default true (hard pin)."
            ),
          usageCredits: z
            .boolean()
            .optional()
            .describe(
              "Allow runs to spend usage-credits past subscription limits (needs extra usage enabled on the account). Default false."
            ),
          prReviewer: z
            .string()
            .optional()
            .describe(
              "Reviewer to request on PRs this automation opens — a GitHub login, an 'org/team' slug, or a comma-separated list. Without one the PR reaches nobody's review queue. The target must be a collaborator on the repo."
            ),
          owner: z
            .string()
            .optional()
            .describe(
              "Who is accountable for what this automation does. It appears in their sidebar under Automations. Omit to leave it unowned."
            ),
          workspaceId: z
            .string()
            .optional()
            .describe(
              "Optional workspace id to file this automation under. Its runs stay in the Automations section either way."
            ),
        },
        async (args: {
          name: string;
          prompt: string;
          schedule?: string;
          mode?: "ask" | "code";
          repo?: string;
          mcpServers?: string[];
          model?: string;
          accountId?: string;
          accountStrict?: boolean;
          usageCredits?: boolean;
          prReviewer?: string;
          owner?: string;
          workspaceId?: string;
        }) => {
          const res = createAutomation({
            name: args.name,
            prompt: args.prompt,
            schedule: args.schedule || "",
            mode: args.mode || "ask",
            createdBy: ctx.createdBy,
            repo: args.repo,
            mcpServers: args.mcpServers,
            model: args.model,
            accountId: args.accountId,
            accountStrict: args.accountStrict,
            usageCredits: args.usageCredits,
            prReviewer: args.prReviewer,
            owner: args.owner,
            workspaceId: args.workspaceId,
          });
          if ("error" in res) return text(`Couldn't create it: ${res.error}`);
          // Name the repo back, including when it was defaulted: a routine
          // pointed at the wrong checkout only fails once it runs.
          const runsIn = res.repo || defaultRepoId();
          return text(
            `Created automation *${res.name}* [\`${res.id}\`]` +
              (res.schedule ? ` on cron \`${res.schedule}\` (UTC)` : " (manual/webhook)") +
              `, mode ${res.mode}` +
              (runsIn ? `, repo ${runsIn}${res.repo ? "" : " (instance default)"}` : "") +
              "."
          );
        }
      ),
      tool(
        "update_automation",
        "Update an existing automation by id. Only provided fields change. Use enabled to pause/resume.",
        {
          id: z.string(),
          name: z.string().optional(),
          prompt: z.string().optional(),
          schedule: z.string().optional().describe("5-field UTC cron; '' clears it."),
          mode: z.enum(["ask", "code"]).optional(),
          enabled: z.boolean().optional(),
          repo: z
            .string()
            .optional()
            .describe(`${repoParamHelp()} '' resets it to the instance default.`),
          mcpServers: z.array(z.string()).optional(),
          model: z
            .string()
            .optional()
            .describe(
              "Model id — a tier ('claude-opus-5', 'gpt-5.6-sol') or an engine-prefixed id ('pi/anthropic/claude-opus-5'); '' resets to the default."
            ),
          accountId: z
            .string()
            .optional()
            .describe("Pin runs to this claude-accounts id; '' clears the pin."),
          accountStrict: z
            .boolean()
            .optional()
            .describe("false = soft pin (pool fallback when exhausted); true = hard pin (cost cap)."),
          usageCredits: z
            .boolean()
            .optional()
            .describe("Allow spending usage-credits past subscription limits."),
          prReviewer: z
            .string()
            .optional()
            .describe(
              "Reviewer to request on PRs this automation opens — a GitHub login, an 'org/team' slug, or a comma-separated list; '' clears it."
            ),
          owner: z
            .string()
            .optional()
            .describe(
              "Who is accountable for what this automation does. It appears in their sidebar under Automations; '' leaves it unowned."
            ),
          workspaceId: z
            .string()
            .optional()
            .describe("Workspace id to file this automation under; '' clears it."),
        },
        async (args: {
          id: string;
          name?: string;
          prompt?: string;
          schedule?: string;
          mode?: "ask" | "code";
          enabled?: boolean;
          repo?: string;
          mcpServers?: string[];
          model?: string;
          accountId?: string;
          accountStrict?: boolean;
          usageCredits?: boolean;
          prReviewer?: string;
          owner?: string;
          workspaceId?: string;
        }) => {
          const { id, ...patch } = args;
          const res = updateAutomation(id, patch);
          if ("error" in res) return text(`Couldn't update it: ${res.error}`);
          const runsIn = res.repo || defaultRepoId();
          return text(
            `Updated *${res.name}* [\`${res.id}\`]: ${res.enabled ? "enabled" : "disabled"}, ${res.mode}` +
              (runsIn ? `, repo ${runsIn}${res.repo ? "" : " (instance default)"}` : "") +
              (res.schedule ? `, cron \`${res.schedule}\`` : "")
          );
        }
      ),
      tool(
        "delete_automation",
        "Delete an automation by id. This is permanent.",
        { id: z.string() },
        async (args: { id: string }) => {
          const a = getAutomation(args.id);
          const ok = deleteAutomation(args.id);
          return text(
            ok
              ? `Deleted automation ${a ? `*${a.name}* ` : ""}[\`${args.id}\`].`
              : `No automation with id \`${args.id}\`.`
          );
        }
      ),
      tool(
        "run_automation",
        "Trigger an automation to run now (manual trigger), without waiting for its schedule.",
        { id: z.string() },
        async (args: { id: string }) => {
          const a = getAutomation(args.id);
          if (!a) return text(`No automation with id \`${args.id}\`.`);
          // Fire-and-forget; the run reports into the Open Session session list.
          void runAutomation(a, undefined, { trigger: "manual" }).catch((e) =>
            console.error("[admin] run_automation failed:", e)
          );
          return text(`Triggered *${a.name}* [\`${a.id}\`] — running now.`);
        }
      ),
      tool(
        "schedule_once",
        `Schedule a ONE-OFF run at a future time, after which it auto-deletes — use for 'remind me about this next week', 'run this again in a week', or any one-time scheduled task. \`when\` is a natural time expression ('next Tuesday 9am', 'in a week', 'tomorrow morning', 'in 3 hours') — just pass the user's phrasing through; it's resolved to an exact instant for you. \`prompt\` is what ${personaName()} should do when it fires, written to yourself — it runs as a normal assistant session, so it can post to a channel, DM someone via the Slack MCP, or carry out a task. By default, when this is invoked from a Slack thread, the run is told to post its reminder back into that thread; set replyInThread:false to suppress (e.g. when the prompt should DM someone else instead). Omit mcpServers to give the run the full toolset; pass it to restrict (least-privilege).`,
        {
          when: z
            .string()
            .describe("When to fire, in natural language — e.g. 'next Tuesday 9am', 'in a week', 'tomorrow at 14:00', 'in 3 hours'. Pass the user's wording; it's resolved to an exact UTC instant."),
          prompt: z
            .string()
            .describe("What to do when it fires, addressed to yourself (e.g. 'Remind Alice to review the Q3 deck' or 'DM Bob the latest report')."),
          name: z.string().optional().describe("Short label; defaults to a snippet of the prompt."),
          mode: z
            .enum(["ask", "code"])
            .optional()
            .describe("'ask' = read-only (default), 'code' = worktree + can open PRs."),
          repo: z.string().optional().describe(repoParamHelp()),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe("Optional allowlist of MCP servers the run may use. Omit for the full toolset."),
          replyInThread: z
            .boolean()
            .optional()
            .describe("Post the reminder/result back into the originating Slack thread (default true when in a Slack thread)."),
        },
        async (args: {
          when: string;
          prompt: string;
          name?: string;
          mode?: "ask" | "code";
          repo?: string;
          mcpServers?: string[];
          replyInThread?: boolean;
        }) => {
          if (!args.prompt?.trim()) return text("Nothing to schedule (empty prompt).");
          const iso = await parseWhen(args.when);
          if (!iso) {
            return text(
              `Couldn't read "${args.when}" as a future time. Try something like "next Tuesday 9am", "in a week", or "tomorrow at 14:00".`
            );
          }

          // Post back into "this" Slack thread by default — only possible when we
          // actually have one (Slack runs carry channel+threadTs; Open Session doesn't).
          const inSlackThread = !!ctx.threadTs && !!ctx.channel && ctx.channel !== "opensession";
          const replyInThread = args.replyInThread !== false && inSlackThread;

          let prompt = args.prompt.trim();
          let mcpServers = args.mcpServers;
          if (replyInThread) {
            prompt +=
              `\n\nDeliver this with the Slack MCP \`slack_reply_to_thread\`: pass \`channel_id\` ` +
              `\`${ctx.channel}\`, \`thread_ts\` \`${ctx.threadTs}\`, and the reminder as \`text\`. ` +
              `Open with "⏰ ", say it's you, ${personaName()}, and keep it concise.`;
            // Make sure the run can reach Slack even if the caller restricted servers.
            if (mcpServers) mcpServers = Array.from(new Set([...mcpServers, "slack"]));
          }

          const res = createAutomation({
            name: args.name?.trim() || `Reminder: ${args.prompt.trim().slice(0, 48)}`,
            prompt,
            schedule: "",
            runOnceAt: iso,
            mode: args.mode || "ask",
            createdBy: ctx.createdBy,
            repo: args.repo,
            mcpServers,
          });
          if ("error" in res) return text(`Couldn't schedule it: ${res.error}`);
          return text(
            `Scheduled *${res.name}* [\`${res.id}\`] for ${iso} (UTC)` +
              (replyInThread ? ", posting back to this thread" : "") +
              ". It runs once, then cleans itself up. Cancel with delete_automation."
          );
        }
      ),
      // ---------------------------------------------------------------------
      // MCP connections
      // ---------------------------------------------------------------------
      tool(
        "list_mcp_servers",
        `List the configured MCP servers (connections) ${personaName()} can use.`,
        {},
        async () => {
          const cfg = readMcpConfig().mcpServers || {};
          const names = Object.keys(cfg);
          if (!names.length) return text("No MCP servers configured.");
          const lines = names.map((n) => {
            const s = cfg[n] || {};
            const where = s.url
              ? `http ${s.url}`
              : `stdio ${[s.command, ...(s.args || [])].join(" ")}`;
            const restricted =
              Array.isArray(s.allowedUsers) && s.allowedUsers.length
                ? ` — 🔒 only ${s.allowedUsers.join(", ")}`
                : "";
            return `• *${n}* — ${where}${restricted}`;
          });
          return text(lines.join("\n"));
        }
      ),
      tool(
        "add_mcp_server",
        "Install/configure a new MCP server. For 'http' provide url; for 'stdio' provide command (and optional args/env). Picked up on the next message — no restart. Secrets go in env/headers and aren't echoed back. Pass allowedUsers to restrict the server to specific people (least-privilege); omit for a server everyone can use.",
        {
          name: z
            .string()
            .describe("Unique short name (alphanumeric, dashes/underscores)."),
          transport: z.enum(["http", "stdio"]),
          url: z.string().optional().describe("Required for http transport."),
          command: z.string().optional().describe("Required for stdio transport."),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          allowedUsers: z
            .array(z.string())
            .optional()
            .describe(
              "Optional per-user allowlist — only these people's sessions get this server's tools. Names/first-names/emails/GitHub logins/Slack ids all resolve. Omit for a server available to everyone."
            ),
        },
        async (args: {
          name: string;
          transport: "http" | "stdio";
          url?: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          allowedUsers?: string[];
        }) => {
          const res = addMcpServer(args);
          if ("error" in res) return text(`Couldn't add it: ${res.error}`);
          const restricted = args.allowedUsers?.length
            ? ` Restricted to ${args.allowedUsers.join(", ")}.`
            : "";
          return text(
            `Added MCP server *${args.name}* (${args.transport}). It'll be available on the next message.${restricted}`
          );
        }
      ),
      tool(
        "set_mcp_allowed_users",
        "Restrict an existing MCP server to specific people, or lift the restriction. Pass allowedUsers to lock it down (only their sessions get its tools); pass an empty list (or omit) to make it available to everyone again. Names/first-names/emails/GitHub logins/Slack ids all resolve.",
        {
          name: z.string().describe("The MCP server to restrict."),
          allowedUsers: z
            .array(z.string())
            .optional()
            .describe("People allowed to use it. Empty/omitted = available to everyone."),
        },
        async (args: { name: string; allowedUsers?: string[] }) => {
          const res = setMcpAllowedUsers(args.name, args.allowedUsers);
          if ("error" in res) return text(`Couldn't update it: ${res.error}`);
          return text(
            res.allowedUsers?.length
              ? `*${args.name}* is now restricted to ${res.allowedUsers.join(", ")}. Applies on the next message.`
              : `*${args.name}* is now available to everyone. Applies on the next message.`
          );
        }
      ),
      tool(
        "remove_mcp_server",
        "Remove a configured MCP server by name.",
        { name: z.string() },
        async (args: { name: string }) => {
          const res = removeMcpServer(args.name);
          if ("error" in res) return text(`Couldn't remove it: ${res.error}`);
          return text(`Removed MCP server *${args.name}*.`);
        }
      )
    );
  }

  return createSdkMcpServer({
    name: "opensession-admin",
    version: "1.0.0",
    tools,
  });
}
