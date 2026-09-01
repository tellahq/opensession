/**
 * opensession-papercuts — an in-process MCP server for logging papercuts: small
 * frictions hit while working (a retried tool call, a flaky command, a stale
 * cache, a misleading error, an undocumented gotcha). Entries land in the
 * central papercuts store (src/server/papercuts.ts) tagged with repo/session/
 * model, and surface in Settings → Papercuts and the nightly audit digest.
 *
 * Unlike the other opensession-* siblings this one IS wired into automation
 * runs too (automations.ts) — friction in unattended runs is exactly what
 * nobody sees otherwise. That's safe because the write tool is append-only
 * into an internal log a human reviews; the worst untrusted ticket text can do
 * is spam it. Never add session-control or config tools here.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  listPapercuts,
  logPapercut,
  papercutsRepoConfigs,
} from "../../server/papercuts";

export interface PapercutsToolContext {
  sessionId?: string;
  /** Journal-style run kind: prompt, slack, automation, … */
  runKind: string;
  /** Who is driving: a user, or "<name> (automation)". */
  by?: string;
  /** Resolved lazily per call — the session's repo/model can change mid-run. */
  defaults: () => { repo?: string; model?: string };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createPapercutsMcpServer(ctx: PapercutsToolContext) {
  const tools = [
    tool(
      "log_papercut",
      "Log a papercut: a small friction you hit while working — a tool call that missed and had to be retried, a confusing or undocumented setup step, a flaky command, a stale cache, a misleading error, a non-obvious gotcha. One or two sentences: what you were doing → what got in the way (a guess at the cause/fix is a bonus). Log proactively, in the moment, even though none of these block you — together they show where the repo needs sanding down. Not for real bugs (Linear) or for what you accomplished (your report).",
      {
        message: z
          .string()
          .describe(
            "The papercut, 1-2 sentences: what you were doing → what got in the way (optionally a guessed cause/fix).",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Registered repo id the friction belongs to. Defaults to this session's repo; pass explicitly when it concerns an attached repo or the tooling of a different one.",
          ),
      },
      async (args: { message: string; repo?: string }) => {
        try {
          const d = ctx.defaults();
          const entry = logPapercut({
            message: args.message,
            repo: args.repo || d.repo,
            sessionId: ctx.sessionId,
            model: d.model,
            runKind: ctx.runKind,
            by: ctx.by,
          });
          return text(
            `Logged${entry.repo ? ` for ${entry.repo}` : ""}. Keep them coming — log each papercut as you hit it.`,
          );
        } catch (e: any) {
          return text(`Couldn't log papercut: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "list_papercuts",
      "List recently logged papercuts (newest first) — the accumulated small frictions across sessions. Useful when asked where a repo needs sanding down, or to check whether a friction you just hit is already a known theme.",
      {
        repo: z
          .string()
          .optional()
          .describe("Only papercuts for this repo id. Omit for all repos."),
        days: z
          .number()
          .optional()
          .describe("How many days back to look (default 14, max 120)."),
      },
      async (args: { repo?: string; days?: number }) => {
        const entries = listPapercuts({
          repo: args.repo,
          days: args.days,
          limit: 50,
        });
        if (!entries.length) {
          const repos = papercutsRepoConfigs()
            .filter((r) => r.enabled)
            .map((r) => r.repoId);
          return text(
            `No papercuts logged${args.repo ? ` for ${args.repo}` : ""} in the last ${args.days || 14} days. (Logging is on for: ${repos.join(", ")}.)`,
          );
        }
        const lines = entries.map(
          (e) =>
            `- [${e.ts.slice(0, 16).replace("T", " ")}]${e.repo ? ` (${e.repo})` : ""}${e.by ? ` ${e.by}:` : ""} ${e.message}`,
        );
        return text(lines.join("\n"));
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-papercuts",
    version: "1.0.0",
    tools,
  });
}
