/**
 * opensession-humans — an in-process MCP server that lets an Open Session session pull a
 * *teammate* into the loop: ask them a question over Slack and fold their answer
 * back into the session. The "human in the loop" surface.
 *
 * Like opensession-sessions / opensession-admin, this is an in-process SDK MCP wired ONLY
 * into interactive runs (Slack processMessage + Open Session interactiveMcpServers),
 * never into automation runs — untrusted ticket text must not be able to DM the
 * team as the bot. Its tools go through src/server/human-asks.ts, which owns the
 * ask registry, the Slack delivery, reply matching, and routing the answer back
 * through the session-control registry.
 *
 * Gating: creating/cancelling asks is gated to the trusted user via `isAdmin`
 * (sending DMs to the team as the bot is outward-facing); listing is open to any
 * whitelisted user. In Open Session sessions everyone is treated as admin (the UI is
 * Tailscale- and team-gated already), matching opensession-sessions.
 */
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  registerAsk,
  awaitBlockingAnswer,
  resolveAskFromUI,
  listAsks,
  cancelAsk,
  type DeliverWhen,
  type HumanAsk,
} from "../../server/human-asks";
import { offerAskCard } from "../../server/asks";
import {
  AWS_HUMAN_AUTH_DENIAL,
  isAwsHumanAuthRequest,
} from "../../server/aws-creds";
import { resolveTeammate } from "../../server/shared/user-mappings";
import { configuredIdentity, personaName } from "../../server/config";
import { parseWhen } from "./parse-when";

export interface HumansToolContext {
  /** Open Session session this MCP instance belongs to — answers route back here. */
  sessionId: string;
  /** Display name credited as the asker in the teammate's DM. */
  createdBy: string;
  /** Trusted user — gates ask_human / cancel_ask. */
  isAdmin: boolean;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function describeDeliver(d: DeliverWhen): string {
  if (d === "now") return "now";
  if (d === "when_done") return "when this session next goes idle";
  if (d === "on_pr") return "once this session has opened a PR";
  return `at ${d.atIso}`;
}

function oneLine(a: HumanAsk): string {
  // A uiFirst ask is "scheduled" right up until the Slack fallback fires, which
  // reads as "nothing has happened yet" — say where it actually is.
  const state =
    a.state === "scheduled" && a.uiOfferedAt
      ? "live in this session's UI"
      : a.state;
  const bits = [
    `\`${a.id}\` → *${a.person.name}*`,
    state,
    a.mode,
    describeDeliver(a.deliver),
  ];
  if (a.state === "answered" && a.answer) {
    bits.push(
      `answered: "${a.answer.slice(0, 60)}${a.answer.length > 60 ? "…" : ""}"`,
    );
  }
  return `• ${bits.join(" · ")}\n   _${a.question.slice(0, 120)}_`;
}

export function createHumansMcpServer(ctx: HumansToolContext) {
  const tools: any[] = [
    tool(
      "list_pending_asks",
      "List the human-in-the-loop questions this session has out to teammates (scheduled or awaiting a reply). Pass include_answered to also see ones already answered. Use this to check what you're still waiting on.",
      {
        include_answered: z
          .boolean()
          .optional()
          .describe(
            "Also include asks that have already been answered/cancelled.",
          ),
        all_sessions: z
          .boolean()
          .optional()
          .describe("List asks across all sessions, not just this one."),
      },
      async (args: { include_answered?: boolean; all_sessions?: boolean }) => {
        const list = listAsks({
          sessionId: args.all_sessions ? undefined : ctx.sessionId,
          includeAnswered: args.include_answered,
        });
        if (!list.length) return text("No outstanding human asks.");
        return text(
          [`${list.length} ask(s):`, "", ...list.map(oneLine)].join("\n"),
        );
      },
    ),
  ];

  if (ctx.isAdmin) {
    tools.push(
      tool(
        "ask_human",
        [
          `Ask a teammate a question over Slack and fold their answer back into this session — the 'human in the loop' tool. ${personaName()} DMs them as the configured assistant, and when they reply it comes back to you.`,
          "",
          "person: who to ask — a first name ('grant', 'john'), full name, or Slack id.",
          "question: what you need from them. Be specific and self-contained.",
          "context (optional): extra background to include in the DM — paste the copy slot, a diff, a screenshot description, the decision at stake. Higher-quality context → faster, better answers.",
          "options (optional): a short list of choices → they get one-tap buttons (plus an 'Other…' free-text fallback). Omit for an open-ended reply.",
          "",
          "mode:",
          "- 'block' — you NEED the answer to keep going right now. Your turn pauses (up to ~20 min) until they reply, then this tool returns their answer and you continue. The question also shows as a card in the session UI, so whoever is watching can answer (or confirm an out-of-band action, like completing a login you asked for) without waiting on Slack. If nobody replies in time it returns empty and the ask becomes async, so a later reply still resumes the session. Use for 'ask Grant for the copy' when you can't proceed without it.",
          "- 'async' (default) — you DON'T need it right now. Returns immediately so you keep working; when they reply, the answer is delivered into this session as a new message. Use for 'get John's review' etc.",
          "",
          "Where an async question lands: if you're asking the person who is driving THIS session, it goes up as a card in the session first and only becomes a Slack DM if nobody answers it there within a few minutes — they're already looking at the session, so that's where the question belongs. Asks aimed at anyone else are DM'd straight away. Either way the reply comes back into this session; you don't have to think about it.",
          "",
          "deliver_when (async only — when the teammate is actually pinged):",
          "- 'now' (default) — ping immediately.",
          "- 'when_done' — hold the ping until this session next finishes its work (goes idle).",
          "- 'on_pr' — hold the ping until this session has opened a PR. Best for 'ask John for a review when done' — a review needs the PR.",
          "- 'at_time' — ping at a future time given in at_time (e.g. 'in 3 hours', 'tomorrow 9am').",
        ].join("\n"),
        {
          person: z
            .string()
            .describe("Teammate to ask: first name, full name, or Slack id."),
          question: z
            .string()
            .describe("The specific, self-contained question."),
          context: z
            .string()
            .optional()
            .describe("Extra background to include in the DM."),
          options: z
            .array(z.string())
            .optional()
            .describe("Quick-pick choices → buttons. Omit for free-text."),
          mode: z
            .enum(["block", "async"])
            .optional()
            .describe(
              "'block' = pause and wait; 'async' (default) = keep going, answer comes back later.",
            ),
          deliver_when: z
            .enum(["now", "when_done", "on_pr", "at_time"])
            .optional()
            .describe("When to ping (async only). Default 'now'."),
          at_time: z
            .string()
            .optional()
            .describe(
              "Required when deliver_when='at_time': a natural-language time, e.g. 'in 3 hours'.",
            ),
        },
        async (args: {
          person: string;
          question: string;
          context?: string;
          options?: string[];
          mode?: "block" | "async";
          deliver_when?: "now" | "when_done" | "on_pr" | "at_time";
          at_time?: string;
        }) => {
          if (!args.question?.trim()) return text("Need a question to ask.");
          if (isAwsHumanAuthRequest(args.question, args.context)) {
            return text(AWS_HUMAN_AUTH_DENIAL);
          }
          const person = resolveTeammate(args.person);
          if (!person) {
            const examples = configuredIdentity()
              .team.slice(0, 4)
              .map((member) => member.aliases?.[0] || member.name)
              .join(", ");
            return text(
              `I don't know who "${args.person}" is — give me a configured teammate name${examples ? ` (for example: ${examples})` : ""} or their Slack id.`,
            );
          }

          const mode = args.mode || "async";
          let deliver: DeliverWhen = "now";
          if (mode === "block") {
            deliver = "now"; // blocking is always immediate
          } else {
            const dw = args.deliver_when || "now";
            if (dw === "at_time") {
              if (!args.at_time?.trim()) {
                return text(
                  "deliver_when='at_time' needs an at_time like 'in 3 hours'.",
                );
              }
              const iso = await parseWhen(args.at_time);
              if (!iso) {
                return text(
                  `I couldn't read "${args.at_time}" as a future time. Try 'in 3 hours' or 'tomorrow 9am'.`,
                );
              }
              deliver = { atIso: iso };
            } else {
              deliver = dw; // 'now' | 'when_done' | 'on_pr'
            }
          }

          const ask = registerAsk({
            sessionId: ctx.sessionId,
            createdBy: ctx.createdBy,
            person,
            question: args.question.trim(),
            context: args.context?.trim() || undefined,
            options: args.options,
            mode,
            deliver,
          });

          if (mode === "block") {
            // The Slack DM is the primary channel, but the session's own
            // driver is watching the UI — surface the same question as a card
            // there too (2026-07-10 SSO wedge: the block ask was invisible in
            // the UI, so the session just looked stuck and got interrupted).
            // Whoever answers first wins: a UI answer resolves the ask, which
            // settles the await below; the card is retracted once the wait
            // ends either way.
            const card = await offerAskCard(
              ctx.sessionId,
              [
                {
                  question:
                    `Waiting on **${person.name}** (asked over Slack): ${args.question.trim()}\n\n` +
                    `If you know the answer — or already handled it out-of-band — answer here to unblock the session immediately.`,
                  header: "Human ask",
                  options: args.options?.map((label) => ({ label })),
                },
              ],
              (answers) => {
                if (!answers) return;
                const v = Object.values(answers).filter(Boolean).join("\n");
                if (v)
                  resolveAskFromUI(
                    ask.id,
                    v,
                    ctx.createdBy || "the session driver",
                  );
              },
            );
            try {
              const answer = await awaitBlockingAnswer(ask.id);
              if (answer === null) {
                return text(
                  `No reply from ${person.name} within the wait window. I've left the question open (\`${ask.id}\`) — when they answer, it'll come back into this session. For now, proceed with your best judgment and note the open question.`,
                );
              }
              return text(`${person.name} replied:\n\n${answer}`);
            } finally {
              await card.close();
            }
          }

          if (ask.uiFirst) {
            return text(
              `Asked ${person.name} — the question is up in this session, where they're already watching. ` +
                `\`${ask.id}\` — if nobody answers it here in the next few minutes I'll DM them on Slack. ` +
                `Either way their reply comes back into this session; keep working.`,
            );
          }
          return text(
            `Asked ${person.name} (${describeDeliver(deliver)}). \`${ask.id}\` — I'll keep working; their reply will come back into this session as a new message.`,
          );
        },
      ),
      tool(
        "cancel_ask",
        "Cancel an outstanding human ask by id (from list_pending_asks). If it was already sent, the teammate gets a quick 'never mind' note.",
        { id: z.string().describe("The ask id, e.g. 'ask-…'.") },
        async (args: { id: string }) => {
          const ok = cancelAsk(args.id);
          return text(
            ok
              ? `Cancelled \`${args.id}\`.`
              : `Nothing to cancel for \`${args.id}\`.`,
          );
        },
      ),
    );
  }

  return createSdkMcpServer({
    name: "opensession-humans",
    version: "1.0.0",
    tools,
  });
}
