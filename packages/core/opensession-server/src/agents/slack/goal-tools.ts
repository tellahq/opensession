/**
 * Two in-process MCP servers for Goals (see src/server/goals.ts).
 *
 * - opensession-goals — management surface, a sibling of opensession-admin. Wired into
 *   interactive runs only (never automation runs), gated to the trusted user for
 *   mutations. Lets the agent create/list/steer long-running goals conversationally.
 *
 * - opensession-goal-self — the *running goal's own* control surface, bound to one
 *   goal id. Attached only to that goal's session run (see goalMcpServers in
 *   opensession.ts). It lets the mission pace itself (set_next_wake), pause for a
 *   human decision (mark_paused), declare success (mark_done), and write to its
 *   durable ledger. It only ever mutates its own goal record — low blast radius,
 *   which is why it's safe on an otherwise-headless run.
 */
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { personaName } from "../../server/config";
import {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  resumeGoal,
  appendLedger,
  saveGoal,
} from "../../server/goals";
import { parseWhen } from "./parse-when";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ── opensession-goals (management) ───────────────────────────────

export interface GoalsToolContext {
  /** Display name credited as the goal creator. */
  createdBy: string;
  /** Trusted user — gates create/update/delete/steer. */
  isAdmin: boolean;
}

export function createGoalsMcpServer(ctx: GoalsToolContext) {
  const tools: any[] = [
    tool(
      "list_goals",
      `List ${personaName()}'s long-running goals (persistent, self-pacing missions): status, phase, next wake, and last run. Use to see what's in flight before creating a new one.`,
      {},
      async () => {
        const all = listGoals();
        if (!all.length) return text("No goals yet.");
        return text(
          all
            .map((g) => {
              const bits = [
                `*${g.name}* [\`${g.id}\`]`,
                g.status,
                g.mode,
                `wake #${g.wakeCount}`,
                g.status === "active" ? `next ${g.nextWakeAt}` : "",
                g.phase ? `phase: ${g.phase}` : "",
                g.pauseReason ? `paused: ${g.pauseReason}` : "",
                g.doneReason ? `done: ${g.doneReason}` : "",
              ].filter(Boolean);
              return `• ${bits.join(" · ")}`;
            })
            .join("\n"),
        );
      },
    ),
    tool(
      "get_goal",
      "Get the full detail of one goal by id, including its mission and the tail of its fact ledger.",
      { id: z.string() },
      async (args: { id: string }) => {
        const g = getGoal(args.id);
        if (!g) return text(`No goal with id \`${args.id}\`.`);
        let ledgerTail = "";
        try {
          const fs = await import("fs");
          if (fs.existsSync(g.stateFile)) {
            ledgerTail = fs.readFileSync(g.stateFile, "utf-8").slice(-2000);
          }
        } catch {}
        return text(
          `*${g.name}* [\`${g.id}\`] — ${g.status}, ${g.mode}, wake #${g.wakeCount}\n` +
            `next wake: ${g.nextWakeAt} (floor ${g.minWakeMinutes}m${g.maxWakes ? `, cap ${g.maxWakes}` : ""})\n` +
            (g.phase ? `phase: ${g.phase}\n` : "") +
            (g.osSessionId ? `session: \`${g.osSessionId}\`\n` : "") +
            `\n*Mission:*\n${g.mission}\n` +
            (ledgerTail ? `\n*Ledger (tail):*\n${ledgerTail}` : ""),
        );
      },
    ),
  ];

  if (ctx.isAdmin) {
    tools.push(
      tool(
        "create_goal",
        `Create a long-running goal: a persistent, self-pacing mission ${personaName()} pursues over days/weeks, remembering its own progress across wakes. Give a thorough \`mission\` prompt (the full brief — objective, strategy, operating loop, hard rules). Pick mode 'ask' for research/measurement only, or 'code' if it must edit files and open PRs (gets a persistent worktree). It wakes itself on its own cadence; set firstWakeAt to delay the first wake, minWakeMinutes as a cadence floor, and maxWakes as a safety cap.`,
        {
          name: z.string().describe("Short display name."),
          mission: z
            .string()
            .describe(
              "The full mission brief — restated to the agent every wake.",
            ),
          mode: z
            .enum(["ask", "code"])
            .optional()
            .describe(
              "'ask' = read-only (default), 'code' = persistent worktree + can open PRs.",
            ),
          repo: z
            .string()
            .optional()
            .describe(
              "Registered project id for code mode (defaults to the instance's primary repo).",
            ),
          model: z
            .string()
            .optional()
            .describe("Optional model id (e.g. 'claude-opus-5')."),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe(
              "Optional allowlist of external MCP servers the runs may use (e.g. ['ahrefs']).",
            ),
          firstWakeAt: z
            .string()
            .optional()
            .describe(
              "Natural-language time for the FIRST wake, e.g. 'now', 'tomorrow 9am'. Default: next tick.",
            ),
          minWakeMinutes: z
            .number()
            .optional()
            .describe(
              "Minimum minutes between wakes (cadence floor). Default 30.",
            ),
          maxWakes: z
            .number()
            .optional()
            .describe(
              "Safety cap on total wakes; auto-pauses on hit. Omit for none.",
            ),
        },
        async (args: {
          name: string;
          mission: string;
          mode?: "ask" | "code";
          repo?: string;
          model?: string;
          mcpServers?: string[];
          firstWakeAt?: string;
          minWakeMinutes?: number;
          maxWakes?: number;
        }) => {
          let firstWakeAt: string | undefined;
          if (
            args.firstWakeAt?.trim() &&
            args.firstWakeAt.trim().toLowerCase() !== "now"
          ) {
            const iso = await parseWhen(args.firstWakeAt);
            if (!iso)
              return text(
                `Couldn't read "${args.firstWakeAt}" as a future time.`,
              );
            firstWakeAt = iso;
          }
          const res = createGoal({
            name: args.name,
            mission: args.mission,
            mode: args.mode,
            repo: args.repo,
            model: args.model,
            mcpServers: args.mcpServers,
            minWakeMinutes: args.minWakeMinutes,
            maxWakes: args.maxWakes,
            firstWakeAt,
            createdBy: ctx.createdBy,
          });
          if ("error" in res) return text(`Couldn't create it: ${res.error}`);
          return text(
            `Created goal *${res.name}* [\`${res.id}\`], mode ${res.mode}. ` +
              `First wake ${res.nextWakeAt}. It'll drive its own session and pace itself from there.`,
          );
        },
      ),
      tool(
        "update_goal",
        "Update a goal by id (only provided fields change). Use to revise the mission, change model/cadence/cap, or edit phase.",
        {
          id: z.string(),
          name: z.string().optional(),
          mission: z.string().optional(),
          mode: z.enum(["ask", "code"]).optional(),
          repo: z.string().optional(),
          model: z.string().optional(),
          mcpServers: z.array(z.string()).optional(),
          minWakeMinutes: z.number().optional(),
          maxWakes: z.number().optional(),
          phase: z.string().optional(),
        },
        async (args: { id: string; [k: string]: unknown }) => {
          const { id, ...patch } = args;
          const res = updateGoal(id, patch as any);
          if ("error" in res) return text(`Couldn't update it: ${res.error}`);
          return text(
            `Updated *${res.name}* [\`${res.id}\`] — ${res.status}, ${res.mode}.`,
          );
        },
      ),
      tool(
        "pause_goal",
        "Pause a goal — the ticker stops waking it until you resume. Use to hold a mission while a decision is pending.",
        { id: z.string(), reason: z.string().optional() },
        async (args: { id: string; reason?: string }) => {
          const res = updateGoal(args.id, {
            status: "paused",
            pauseReason: args.reason?.trim() || "Paused by operator",
          });
          if ("error" in res) return text(`Couldn't pause it: ${res.error}`);
          return text(`Paused *${res.name}* [\`${res.id}\`].`);
        },
      ),
      tool(
        "resume_goal",
        "Resume a paused (or finished) goal and schedule its next wake. Optionally give a time for when it should next wake.",
        {
          id: z.string(),
          when: z
            .string()
            .optional()
            .describe("Natural-language next wake; default now."),
        },
        async (args: { id: string; when?: string }) => {
          let iso: string | undefined;
          if (args.when?.trim() && args.when.trim().toLowerCase() !== "now") {
            iso = (await parseWhen(args.when)) || undefined;
            if (!iso) return text(`Couldn't read "${args.when}" as a time.`);
          }
          const res = resumeGoal(args.id, iso);
          if ("error" in res) return text(`Couldn't resume it: ${res.error}`);
          return text(
            `Resumed *${res.name}* [\`${res.id}\`] — next wake ${res.nextWakeAt}.`,
          );
        },
      ),
      tool(
        "run_goal_now",
        "Wake a goal immediately, without waiting for its schedule (sets its next wake to now; the ticker picks it up within a minute).",
        { id: z.string() },
        async (args: { id: string }) => {
          const g = getGoal(args.id);
          if (!g) return text(`No goal with id \`${args.id}\`.`);
          saveGoal({
            ...g,
            status: "active",
            nextWakeAt: new Date().toISOString(),
          });
          return text(`*${g.name}* will wake within a minute.`);
        },
      ),
      tool(
        "delete_goal",
        "Delete a goal and its ledger. Permanent. The opensession session it created is left as-is.",
        { id: z.string() },
        async (args: { id: string }) => {
          const g = getGoal(args.id);
          const ok = deleteGoal(args.id);
          return text(
            ok
              ? `Deleted goal ${g ? `*${g.name}* ` : ""}[\`${args.id}\`].`
              : `No goal with id \`${args.id}\`.`,
          );
        },
      ),
    );
  }

  return createSdkMcpServer({
    name: "opensession-goals",
    version: "1.0.0",
    tools,
  });
}

// ── opensession-goal-self (the running goal's own controls) ──────

export function createGoalSelfMcpServer(goalId: string) {
  const load = () => getGoal(goalId);

  const tools = [
    tool(
      "set_next_wake",
      "Schedule when you should next wake to continue this mission. `when` is natural language ('in 7 days', 'tomorrow 9am', 'in 4 hours'). Use a long gap after shipping (e.g. 'in 7 days') so rankings/metrics can actually move before you re-measure. Clamped to the goal's minimum cadence.",
      {
        when: z
          .string()
          .describe("Natural-language next wake, e.g. 'in 7 days'."),
      },
      async (args: { when: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        const iso = await parseWhen(args.when);
        if (!iso) return text(`Couldn't read "${args.when}" as a future time.`);
        const floor = Date.now() + g.minWakeMinutes * 60_000;
        const at = Math.max(Date.parse(iso), floor);
        const nextWakeAt = new Date(at).toISOString();
        saveGoal({ ...g, nextWakeAt, status: "active" });
        return text(`Next wake set to ${nextWakeAt}.`);
      },
    ),
    tool(
      "mark_paused",
      "Pause this mission because you're blocked on a human decision or sign-off. Say clearly in `reason` what you need and from whom. (First pull them in with opensession-humans ask_human if you haven't.) The ticker won't wake you again until a human resumes the goal.",
      { reason: z.string().describe("What/who you're blocked on.") },
      async (args: { reason: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        saveGoal({
          ...g,
          status: "paused",
          pauseReason: args.reason?.trim() || "Awaiting human input",
        });
        return text(
          "Marked paused. I'll stay put until a human resumes this goal.",
        );
      },
    ),
    tool(
      "mark_done",
      "Declare this mission complete (its success condition is met). Stops the wake cycle. Summarize the outcome in `reason`.",
      {
        reason: z
          .string()
          .describe("How the mission was completed / final outcome."),
      },
      async (args: { reason: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        saveGoal({
          ...g,
          status: "done",
          doneReason: args.reason?.trim() || "Completed",
        });
        return text("Marked done. The wake cycle is stopped.");
      },
    ),
    tool(
      "mark_failed",
      "Give up on this mission because it can't be completed. Stops the wake cycle. Explain why in `reason`.",
      { reason: z.string().describe("Why the mission can't be completed.") },
      async (args: { reason: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        saveGoal({
          ...g,
          status: "failed",
          doneReason: args.reason?.trim() || "Failed",
        });
        return text("Marked failed. The wake cycle is stopped.");
      },
    ),
    tool(
      "update_phase",
      "Set a short human-readable phase label for where the mission is (e.g. 'week 2: shipping roundup'). Shown in list_goals.",
      { phase: z.string() },
      async (args: { phase: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        saveGoal({ ...g, phase: args.phase?.trim() || undefined });
        return text("Phase updated.");
      },
    ),
    tool(
      "append_ledger",
      "Append to your durable fact ledger — the authoritative record that survives context compaction. Write down baselines, decisions, PR URLs, and measured results here every wake, and read it back at the start of each wake. Be concrete (numbers, links).",
      { text: z.string().describe("What to record (markdown).") },
      async (args: { text: string }) => {
        const g = load();
        if (!g) return text("Goal record missing.");
        if (!args.text?.trim()) return text("Nothing to append.");
        appendLedger(g, args.text);
        return text("Appended to ledger.");
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-goal-self",
    version: "1.0.0",
    tools,
  });
}
