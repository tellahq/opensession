/**
 * opensession-self — in-process MCP server for SELF-IMPROVING automations
 * (automation.selfImprove, a human-set flag; first user: the nightly Dreaming
 * reflection). Sierra-style "dreaming": the automation may rewrite its OWN
 * prompt so tomorrow's run is better than today's.
 *
 * Scope is deliberately tiny: read your own record, update your own prompt.
 * Never other automations (the id is closure-bound at construction), and
 * never schedule/model/mode/mcpServers/repo — capability and cadence changes
 * stay human decisions in the Automations UI. Every prompt update writes a
 * timestamped backup next to the record and an audit event, so a bad self-
 * edit is one `cp` away from undone and always visible in the audit log.
 *
 * Wired per run from runAutomation / the automation-resume paths (see
 * selfImproveMcpServers in automations.ts) — never into ordinary automations
 * and never reachable from sessions that lack the flag.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";

export interface SelfImproveContext {
  /** The owning automation's display name (for tool output only). */
  automationName: string;
  /** Read this automation's own record, fresh from disk. */
  getOwn: () => {
    name: string;
    prompt: string;
    schedule: string;
    mode: string;
    repo?: string;
    model?: string;
    mcpServers?: string[];
  } | null;
  /** Backup + persist a new prompt for this automation only. */
  updateOwnPrompt: (
    newPrompt: string,
    reason: string,
  ) => { ok: true; backupPath: string } | { ok: false; error: string };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createSelfImproveMcpServer(ctx: SelfImproveContext) {
  return createSdkMcpServer({
    name: "opensession-self",
    version: "1.0.0",
    tools: [
      tool(
        "get_own_automation",
        `Read your own automation record ("${ctx.automationName}"): the exact prompt that produced this run, plus schedule/mode/repo/model. Read it before update_own_prompt — edits apply to the CURRENT stored prompt, which may already differ from what this run was started with.`,
        {},
        async () => {
          const a = ctx.getOwn();
          if (!a)
            return text(
              "Could not read this automation's record (was it deleted?).",
            );
          return text(
            [
              `*${a.name}*`,
              `schedule: \`${a.schedule || "(manual/webhook only)"}\` · mode: ${a.mode}${a.repo ? ` · repo: ${a.repo}` : ""}${a.model ? ` · model: ${a.model}` : ""}${a.mcpServers ? ` · mcp: [${a.mcpServers.join(", ")}]` : ""}`,
              "",
              "── current prompt ──",
              a.prompt,
            ].join("\n"),
          );
        },
      ),
      tool(
        "update_own_prompt",
        "Replace your own automation prompt (self-improvement). Pass the COMPLETE new prompt — this is a full replacement, not a patch — and a one-line reason (it lands in the audit log). A timestamped backup of the old record is written first, so a human can revert with one copy. Takes effect on the NEXT run. Improve incrementally and conservatively: keep the prompt's overall structure and every guardrail/safety section intact — a prompt that loses its constraints is a regression, not an improvement. If you're unsure whether a change is wanted, ask in your Slack thread instead of applying it.",
        {
          new_prompt: z
            .string()
            .describe(
              "The complete replacement prompt (full text, not a diff).",
            ),
          reason: z
            .string()
            .describe("One line: what you changed and why (audited)."),
        },
        async (args: { new_prompt: string; reason: string }) => {
          const res = ctx.updateOwnPrompt(args.new_prompt, args.reason);
          if (!res.ok) return text(res.error);
          return text(
            `Prompt updated (takes effect next run). Backup: \`${res.backupPath}\`. Mention this change — and why — in your Slack post/reply so a human sees it.`,
          );
        },
      ),
    ],
  });
}
