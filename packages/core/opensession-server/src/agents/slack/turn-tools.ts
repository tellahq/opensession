/**
 * opensession-turn — the two ways a run ends without saying anything.
 *
 * Borrowed from qm's harness. Both tools are no-ops in the sense that they
 * touch nothing outside the run's own ledger (src/server/turn-outcome.ts);
 * their value is that silence stops being indistinguishable from a crash. An
 * unattended run that ends with neither an outward effect nor one of these
 * calls is logged as a papercut for a human to look at.
 *
 * Because they do nothing but record a decision, they are safe on unattended
 * runs carrying untrusted text — the same argument that puts
 * opensession-papercuts there. Never grow this server past that: the moment a
 * tool here reads or changes anything, the argument stops holding.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { recordDeclaration } from "../../server/turn-outcome";

export interface TurnToolContext {
  /** Ledger key for this run — the opensession session id where there is one. */
  turnKey: string;
  /**
   * A person is waiting on this turn's reply. `finish_silently` is a no-op on
   * an attended turn (and says so), because ending without answering someone
   * who asked is a bug, not a decision.
   */
  attended?: boolean;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createTurnMcpServer(ctx: TurnToolContext) {
  const tools = [
    tool(
      "finish_silently",
      'End this run without reporting anything. ONLY for a scheduled or event-driven run — a poll, a digest check, a triage pass — that genuinely found nothing worth saying. For a check like that silence IS the success case, so call this instead of posting a "nothing to report" note. Calling it is what separates "looked, nothing there" from "stopped early", which otherwise look identical from outside; a run that ends quietly without calling it gets logged as a papercut for a human to check. If you did post a note, send a message, publish a report or ask a teammate, you do NOT need this — that already counts as reporting.',
      {
        reason: z
          .string()
          .optional()
          .describe(
            "One short phrase on why there was nothing to report. Recorded for the audit log and never delivered to anyone.",
          ),
      },
      async (args: { reason?: string }) => {
        if (ctx.attended) {
          return text(
            "[no-op] finish_silently is for unattended runs; somebody is waiting on this turn — just answer them.",
          );
        }
        recordDeclaration(ctx.turnKey, {
          tool: "finish_silently",
          reason: args.reason,
        });
        return text("Noted — finishing without reporting anything.");
      },
    ),
    tool(
      "stay_silent",
      "End this turn without replying, when you were addressed directly and have decided not to answer. Give a one-line reason: it is logged, never shown to anyone. Use it sparingly — the ordinary response to being asked something is to reply.",
      {
        reason: z
          .string()
          .describe(
            "Why you are not replying. Logged for review, never delivered.",
          ),
      },
      async (args: { reason: string }) => {
        recordDeclaration(ctx.turnKey, {
          tool: "stay_silent",
          reason: args.reason,
        });
        return text("Noted — ending this turn without replying.");
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-turn", tools });
}
