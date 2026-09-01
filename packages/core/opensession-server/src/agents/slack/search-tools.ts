/**
 * opensession-search — in-process MCP server over the session history index
 * (src/server/session-index.ts): distilled records of past sessions, searched
 * lexically (FTS5 bm25) with recency decay. Read-only.
 *
 * Two tools, because the index is a VIEW and the transcript is the truth:
 * search_history finds candidate sessions from their distilled records, and
 * read_history (transcript-excerpt.ts) expands a hit back into the real
 * entries around the match — the tool calls, commands and errors the
 * distillation dropped. A search result you act on should be read first.
 *
 * INTERACTIVE RUNS ONLY. Past-session records can contain customer and
 * internal material, so this must never reach automation runs processing
 * untrusted event/ticket text — the run-rpc builder's automation gate
 * (interactive-mcp.ts) fails closed, same as the sessions/admin siblings.
 * Never add write or control tools here.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { searchSessionHistory, searchIndex } from "../../server/session-index";
import {
  transcriptExcerpt,
  formatExcerpt,
} from "../../server/transcript-excerpt";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createSearchMcpServer() {
  const tools = [
    tool(
      "search_history",
      "Search past Open Session sessions (distilled question/resolution records, lexical match + recency-weighted). Use BEFORE re-deriving something that has likely been solved here before: a bug that looks familiar, an error string, 'how did we fix/decide X', which session touched a file or subsystem. Exact tokens work best: error fragments, file names, function names, flag names. Results are distilled records, not the transcript: take the session id of anything you'd act on and expand it with read_history. One piece of work is one result: the sessions of a workspace (the change, its follow-ups, the review spawned to read the diff) fold into a single hit, whose other sessions are listed under it. The listed id is often where the answer actually is, so read it rather than assuming the top record covers the family.",
      {
        query: z
          .string()
          .describe(
            "Search terms. Prefer concrete tokens (error strings, file/function names) over prose.",
          ),
        repo: z
          .string()
          .optional()
          .describe("Only sessions whose primary repo is this registered id."),
        days: z
          .number()
          .optional()
          .describe("Only sessions active in the last N days."),
        limit: z
          .number()
          .optional()
          .describe("Max results (default 8, max 25)."),
      },
      async (args: {
        query: string;
        repo?: string;
        days?: number;
        limit?: number;
      }) => {
        try {
          const hits = searchSessionHistory(args.query, {
            repo: args.repo,
            days: args.days,
            limit: args.limit,
          });
          if (!hits.length) {
            return text(
              `No matches${args.repo ? ` in ${args.repo}` : ""} for "${args.query}" (index holds ${searchIndex().count()} sessions). Try fewer or different tokens.`,
            );
          }
          const lines = hits.map((h, i) => {
            const id = h.id.replace(/^session:/, "");
            const date = new Date(h.ts).toISOString().slice(0, 10);
            const parts = [
              `${i + 1}. [${date}]${h.repo ? ` (${h.repo})` : ""}${h.user ? ` ${h.user}:` : ""} ${h.question}`,
            ];
            if (h.resolution) parts.push(`   → ${h.resolution}`);
            if (h.files)
              parts.push(
                `   files: ${h.files.split(/\s+/).slice(0, 8).join(" ")}`,
              );
            parts.push(`   session: ${id}${h.pr ? ` PR: ${h.pr}` : ""}`);
            // One workspace is one piece of work, so its other sessions fold
            // behind this one. Name them: the leader is only the best-scoring
            // record, and the answer may sit in a sibling.
            if (h.folded?.length) {
              parts.push(
                `   same work (workspace ${h.workspaceId || "?"}), also matched:`,
              );
              for (const f of h.folded.slice(0, 4)) {
                parts.push(
                  `     · ${f.id.replace(/^session:/, "")} ${f.question}`,
                );
              }
              if (h.folded.length > 4) {
                parts.push(`     · +${h.folded.length - 4} more`);
              }
            }
            return parts.join("\n");
          });
          lines.push(
            "\nThese are DISTILLED records — an LLM's one-paragraph view of a session, which is lossy and can be wrong. Before relying on one, expand it with read_history (same query, the session id) to read the actual transcript around the match.",
          );
          return text(lines.join("\n"));
        } catch (e: any) {
          return text(`Search failed: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "read_history",
      "Expand a past session into its REAL transcript — the source of truth behind a search_history hit. Give it the session id and (usually) the same query: it finds where those terms actually occur and returns windows of real entries around each match, including the tool calls and commands the distilled record dropped. Every line is tagged with its seq, so you can page outward with around_seq. Use this whenever a hit looks relevant enough to act on: the record is a paraphrase, this is what happened.",
      {
        session: z
          .string()
          .describe(
            "Session id from a search_history hit (the `session:` prefix is optional).",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Terms to locate inside the transcript — usually the same ones you searched with. Omit to read the end of the session.",
          ),
        around_seq: z
          .number()
          .optional()
          .describe(
            "Read around this seq instead of searching — how you page before/after a window you already saw.",
          ),
        limit: z
          .number()
          .optional()
          .describe("Entries per window (default 12, max 60)."),
        windows: z
          .number()
          .optional()
          .describe(
            "How many separate match windows to return (default 3, max 8).",
          ),
      },
      async (args: {
        session: string;
        query?: string;
        around_seq?: number;
        limit?: number;
        windows?: number;
      }) => {
        try {
          const id = args.session.trim().replace(/^session:/, "");
          if (!id)
            return text("Need a session id (from a search_history hit).");
          const ex = await transcriptExcerpt(id, {
            query: args.query,
            aroundSeq: args.around_seq,
            limit: args.limit,
            windows: args.windows,
          });
          const head = `Transcript of \`${id}\`${
            args.query
              ? ` around "${args.query}"`
              : args.around_seq
                ? ` around seq ${args.around_seq}`
                : " (tail)"
          }${ex.matched === 0 && args.query ? " — no entry carried those terms, showing the tail instead" : ""}`;
          return text(`${head}\n\n${formatExcerpt(ex)}`);
        } catch (e: any) {
          return text(`Read failed: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-search",
    version: "1.0.0",
    tools,
  });
}
