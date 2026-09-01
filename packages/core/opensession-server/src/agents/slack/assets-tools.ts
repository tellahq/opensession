/**
 * opensession-assets is an in-process MCP server for previewable session
 * artifacts: interactive HTML/JS visualizations, generated reports, diagrams,
 * and sample data. Assets use the configured local or S3-compatible backend,
 * never a repo. The session viewer shows a file tree and live preview.
 *
 * The handlers run in the parent process, so this works identically for
 * read-only Ask sessions and sandboxed sessions.
 *
 * Wired like the other siblings: interactive runs only (Open Session web
 * sessions + Slack), never automations.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  assetStorageLocation,
  deleteAssetAcross,
  listAssetsAcross,
  readAssetAcross,
  writeAsset,
  MAX_WRITE_BYTES,
} from "../../server/session-assets";
import { sessionIdsFor } from "../../server/session-cache";

const READ_CAP = 256 * 1024;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function createAssetsMcpServer(ctx: { sessionId: string }) {
  const assetSessionIds = () => sessionIdsFor(ctx.sessionId);
  const tools = [
    tool(
      "write_asset",
      "Save a file into this session's asset storage for preview in the Assets tab or a direct link in chat: interactive HTML/JS visualizations, generated reports, diagrams, and sample data. Add a short description so the viewer explains what the asset shows. Assets are outside every repo and never committed. HTML previews live in the UI and relative references resolve, so multi-file pages work. Overwrites silently. Works in read-only Ask sessions too.",
      {
        path: z
          .string()
          .describe(
            "Relative asset path, e.g. 'report.html' or 'viz/index.html'.",
          ),
        content: z
          .string()
          .describe(
            "The file content (UTF-8 text, or base64 with encoding: 'base64').",
          ),
        description: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A short human-facing explanation of what the asset shows or why it is useful.",
          ),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe(
            "How `content` is encoded. Default utf8; use base64 for binary files (images, pdf).",
          ),
      },
      async (args: {
        path: string;
        content: string;
        description?: string;
        encoding?: "utf8" | "base64";
      }) => {
        try {
          const sessionId = assetSessionIds()[0] || ctx.sessionId;
          const data = Buffer.from(
            args.content,
            args.encoding === "base64" ? "base64" : "utf8",
          );
          const f = await writeAsset(
            sessionId,
            args.path,
            data,
            args.description,
          );
          return text(
            `Saved ${f.path} (${fmtSize(f.size)}). It's visible in this session's Assets tab now.\n` +
              `Reference \`${f.path}\` in chat to give the reader a direct open link.`,
          );
        } catch (e: any) {
          return text(
            `Couldn't write ${args.path}: ${e?.message || String(e)}`,
          );
        }
      },
    ),
    tool(
      "list_assets",
      "List this session's assets (path, size, modified time) and the configured storage location.",
      {},
      async () => {
        const sessionIds = assetSessionIds();
        const location = assetStorageLocation(sessionIds[0] || ctx.sessionId);
        const files = await listAssetsAcross(sessionIds);
        if (!files.length)
          return text(
            "No assets yet. Save files with write_asset; they show up in the " +
              "session's Assets tab with a live preview.",
          );
        const lines = files.map(
          (f) =>
            `  ${f.path}  (${fmtSize(f.size)})${f.description ? ` — ${f.description}` : ""}`,
        );
        return text(
          `Storage: ${location} (write_asset cap ${fmtSize(MAX_WRITE_BYTES)}/file)\n${lines.join("\n")}`,
        );
      },
    ),
    tool(
      "read_asset",
      "Read back a text asset from this session's asset storage (capped at 256 KB).",
      {
        path: z.string().describe("Relative asset path."),
      },
      async (args: { path: string }) => {
        try {
          const found = await readAssetAcross(assetSessionIds(), args.path);
          if (!found) throw new Error(`no such asset: ${args.path}`);
          const body = found.data.subarray(0, READ_CAP).toString("utf8");
          return text(
            found.size > READ_CAP
              ? `${found.path} (${fmtSize(found.size)}, first ${fmtSize(READ_CAP)} shown):\n${body}`
              : `${found.path} (${fmtSize(found.size)}):\n${body}`,
          );
        } catch (e: any) {
          return text(`Couldn't read ${args.path}: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "delete_asset",
      "Delete a file or virtual folder from this session's asset storage.",
      {
        path: z.string().describe("Relative asset path."),
      },
      async (args: { path: string }) => {
        try {
          await deleteAssetAcross(assetSessionIds(), args.path);
          return text(`Deleted ${args.path}.`);
        } catch (e: any) {
          return text(
            `Couldn't delete ${args.path}: ${e?.message || String(e)}`,
          );
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-assets",
    version: "1.0.0",
    tools,
  });
}
