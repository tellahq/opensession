/**
 * opensession-report — publish_report: lets a run publish an HTML report and
 * optional staged assets into the Reports store (~/.opensession-reports, see
 * src/server/reports.ts), grouped per automation and browsed in the frontend
 * Reports view (latest + history per automation).
 *
 * Wired into EVERY automation run (automations.ts), like the papercuts
 * sibling, and held to the same automation in-process bar: publish-only
 * (append into its own automation's group), nothing sensitive readable, no
 * control surface. The automation identity is baked in here — a run can never
 * publish into another automation's group.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  publishReport,
  REPORT_CONFIDENCES,
  REPORT_URGENCIES,
  MAX_REPORT_ASSETS,
  MAX_REPORT_ASSET_BYTES,
  MAX_REPORT_BYTES,
  MAX_REPORT_TASK_PROMPT,
  MAX_REPORT_TASKS,
} from "../../server/reports";
import { safeAssetPath } from "../../server/session-assets";
import { ensureSessionScratch } from "../../server/session-scratch";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createReportMcpServer(ctx: {
  automationId: string;
  automationName: string;
  sessionId?: string;
}) {
  const stagingDir = ctx.sessionId
    ? ensureSessionScratch(ctx.sessionId)
    : undefined;
  const tools = [
    tool(
      "publish_report",
      "Publish this run's HTML report with optional durable assets shown in the Reports view — latest per automation, with history. Store image/media evidence as assets instead of base64 data URLs. Use it when the task's outcome is a recurring readable report; each publish adds a new entry, so publish once per run with the final document.",
      {
        title: z
          .string()
          .describe(
            'Human title for this report, e.g. "Support digest — 2026-07-12".',
          ),
        html: z.string().describe(
          `The full HTML document (max ${Math.floor(MAX_REPORT_BYTES / 1024 / 1024)} MB). Reference staged files as assets/<path> and list those paths in assets.

Write plain semantic HTML and set no colours. Readers view reports in a light or a dark app, and a house stylesheet is applied for whichever one they are in: it styles headings, paragraphs, lists, tables, code, pre, blockquote, images and links, plus .card / .panel for a grouped block, .meta for a byline, and .chip with .positive / .warning / .negative for a status pill. Reuse those instead of inventing a palette. If a document really needs its own CSS, keep it to layout, or answer both schemes with prefers-color-scheme — a hardcoded light palette has to be converted before it can be shown in a dark window.`,
        ),
        assets: z
          .array(z.string())
          .max(MAX_REPORT_ASSETS)
          .optional()
          .describe(
            `Relative file paths staged in this run's scratch directory${stagingDir ? ` (${stagingDir})` : ""}. They are copied into durable report storage and served at assets/<path>. Combined max ${Math.floor(MAX_REPORT_ASSET_BYTES / 1024 / 1024)} MB.`,
          ),
        summary: z
          .string()
          .optional()
          .describe(
            "Short plain-text gist (1-3 sentences) shown in report lists.",
          ),
        urgency: z
          .enum(REPORT_URGENCIES)
          .optional()
          .describe(
            "Overall time-to-action: low, medium, high, or critical. This is urgency, not certainty.",
          ),
        confidence: z
          .enum(REPORT_CONFIDENCES)
          .optional()
          .describe(
            "Overall epistemic confidence: low, medium, or high. This is certainty in the assessment, not importance.",
          ),
        highlights: z
          .array(
            z.object({
              title: z.string(),
              summary: z.string(),
              urgency: z.enum(REPORT_URGENCIES),
              confidence: z.enum(REPORT_CONFIDENCES),
              sourceRefs: z.array(z.string()).max(20).optional(),
            }),
          )
          .max(20)
          .optional()
          .describe(
            "Machine-readable findings used by report history and optional notification outputs. Every finding needs its own urgency, confidence, and evidence references when available.",
          ),
        tasks: z
          .array(z.object({ title: z.string(), prompt: z.string() }))
          .max(MAX_REPORT_TASKS)
          .optional()
          .describe(
            `Follow-up work this report proposes, one per unit of work (max ${MAX_REPORT_TASKS}). A reader can start a session per task from the report, each in its own workspace, so split the work the way you would want it reviewed: one task per independent change, and findings that touch the same code in one task rather than several. This is not the findings list — publish every piece of work, not just the top few.

title: a short label for the picker row.
prompt: the whole opening prompt for that session (max ${MAX_REPORT_TASK_PROMPT} characters). It is all the agent gets, so it must stand alone: what is wrong, the files to touch, what done looks like, and how to verify. Name no other task.`,
          ),
      },
      async (args: {
        title: string;
        html: string;
        assets?: string[];
        summary?: string;
        urgency?: (typeof REPORT_URGENCIES)[number];
        confidence?: (typeof REPORT_CONFIDENCES)[number];
        highlights?: Array<{
          title: string;
          summary: string;
          urgency: (typeof REPORT_URGENCIES)[number];
          confidence: (typeof REPORT_CONFIDENCES)[number];
          sourceRefs?: string[];
        }>;
        tasks?: Array<{ title: string; prompt: string }>;
      }) => {
        try {
          if (args.assets?.length && !ctx.sessionId)
            throw new Error("Report assets require a session id");
          if (args.assets?.length && !stagingDir)
            throw new Error("Report assets require session scratch");
          const realStagingDir = args.assets?.length
            ? realpathSync(stagingDir!)
            : null;
          let assetBytes = 0;
          const assetPaths = new Set<string>();
          const assets = (args.assets || []).map((path) => {
            const rel = safeAssetPath(path);
            if (assetPaths.has(rel))
              throw new Error(`Duplicate report asset: ${rel}`);
            assetPaths.add(rel);
            const candidate = resolve(join(stagingDir!, rel));
            if (!lstatSync(candidate).isFile())
              throw new Error(`Not a file: ${path}`);
            const realPath = realpathSync(candidate);
            if (!realPath.startsWith(`${realStagingDir!}/`))
              throw new Error(
                `Asset resolves outside session scratch: ${path}`,
              );
            assetBytes += statSync(realPath).size;
            if (assetBytes > MAX_REPORT_ASSET_BYTES)
              throw new Error(
                `Report assets too large (${assetBytes} bytes > ${MAX_REPORT_ASSET_BYTES})`,
              );
            return { path: rel, data: readFileSync(realPath) };
          });
          const meta = publishReport({
            automationId: ctx.automationId,
            automationName: ctx.automationName,
            sessionId: ctx.sessionId,
            title: args.title,
            html: args.html,
            summary: args.summary,
            urgency: args.urgency,
            confidence: args.confidence,
            highlights: args.highlights,
            tasks: args.tasks,
            assets,
          });
          return text(
            `Published report "${meta.title}" (${meta.id}). It's now the latest report for "${ctx.automationName}" in the Reports view.${
              meta.tasks?.length
                ? ` A reader can start ${meta.tasks.length} session${meta.tasks.length === 1 ? "" : "s"} from it, one per task.`
                : ""
            }`,
          );
        } catch (e: any) {
          return text(`Failed to publish report: ${e?.message || e}`);
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "opensession-report", tools });
}
