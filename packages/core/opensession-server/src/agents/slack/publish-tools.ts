/**
 * opensession-publish — turn a directory in this session's worktree into a
 * durable internal web app (src/server/deploys.ts).
 *
 * Interactive runs only. A deploy is arbitrary agent-authored code that keeps
 * running after the session ends; automation runs process untrusted text and
 * must never be able to leave a persistent process behind.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import {
  deployUrl,
  getDeploy,
  listDeploys,
  publishDeploy,
  rollbackDeploy,
  stopDeploy,
} from "../../server/deploys";

export interface PublishToolContext {
  sessionId: string;
  user: string;
  /** The session's worktree — publishable paths must resolve inside it. */
  worktreeDir: () => string | undefined;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createPublishMcpServer(ctx: PublishToolContext) {
  const tools = [
    tool(
      "publish_app",
      "Publish a directory from this session's worktree as a durable internal web app: it keeps running after this session ends and gets a stable link at /d/<name>/. The app MUST listen on the port in the PORT env var. Every publish creates a new immutable version; pass `name` again to update an existing app in place. IMPORTANT — durability: only $DATA_DIR survives a restart or redeploy; the rest of the app's disk is reset from the published snapshot every time it relaunches. Keep any state the app writes (a SQLite file, uploads, caches you care about) under $DATA_DIR. The app runs with a minimal environment — no Open Session tokens — so pass anything it needs via `env`, and remember node_modules/.git/dist are NOT copied: vendor what you need or keep the app dependency-free. Everyone who can reach Open Session can reach the app; don't publish anything that needs per-person privacy.",
      {
        dir: z
          .string()
          .describe(
            "Directory to publish, absolute or relative to the session's worktree. Its contents become the app root.",
          ),
        entrypoint: z
          .string()
          .describe(
            'Shell command that starts the server, run from the app root, e.g. "bun server.ts" or "node index.js". It must bind $PORT.',
          ),
        name: z
          .string()
          .describe(
            "Stable handle → the link becomes /d/<name>/. Lowercase letters, digits and hyphens. Reuse the same name to ship a new version of an existing app.",
          ),
        description: z
          .string()
          .optional()
          .describe("One line on what the app is, shown in the Deploys list."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Environment variables baked into this version. Never put a real secret here.",
          ),
        renameFrom: z
          .string()
          .optional()
          .describe(
            "Rename the app currently called this to `name` instead of creating a new one.",
          ),
      },
      async (args: {
        dir: string;
        entrypoint: string;
        name: string;
        description?: string;
        env?: Record<string, string>;
        renameFrom?: string;
      }) => {
        const worktree = ctx.worktreeDir();
        const dir = isAbsolute(args.dir)
          ? resolve(args.dir)
          : resolve(worktree || process.cwd(), args.dir);
        // A session may only publish out of its own checkout — otherwise
        // "publish $HOME" is a one-call exfiltration of the whole box
        // onto a team-visible URL.
        if (worktree && !dir.startsWith(resolve(worktree))) {
          return text(
            `Refused: ${dir} is outside this session's worktree (${worktree}). Publish a directory you built inside the session.`,
          );
        }
        try {
          const r = publishDeploy({
            dir,
            entrypoint: args.entrypoint,
            name: args.name,
            owner: ctx.user,
            sessionId: ctx.sessionId,
            ...(args.description ? { description: args.description } : {}),
            ...(args.env ? { env: args.env } : {}),
            ...(args.renameFrom ? { renameFrom: args.renameFrom } : {}),
          });
          return text(
            `Published **${r.deploy.name}** v${r.version} → ${r.url}\n` +
              `State: ${r.deploy.state}. Durable data path: $DATA_DIR (everything else resets on relaunch).\n` +
              `Check it responds before telling anyone it's ready — if the app fails to bind $PORT it will crash-loop and the link will 503.`,
          );
        } catch (e: any) {
          return text(`Publish failed: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "list_apps",
      "List the published internal apps — name, link, running state, current version and owner. Use it before publishing to see whether the app you're about to create already exists (reuse its name to ship a new version rather than making a near-duplicate).",
      {},
      async () => {
        const all = listDeploys();
        if (!all.length) return text("No apps are published yet.");
        return text(
          all
            .map(
              (d) =>
                `- **${d.name}** (v${d.currentVersion}, ${d.state}) — ${deployUrl(d.name)}` +
                (d.description ? ` — ${d.description}` : "") +
                ` — owner ${d.owner}` +
                (d.lastError ? `\n  last error: ${d.lastError}` : ""),
            )
            .join("\n"),
        );
      },
    ),
    tool(
      "rollback_app",
      "Flip a published app back to an earlier version, e.g. when the version you just shipped is broken. list_apps shows the current version; the last 10 versions are retained.",
      {
        name: z.string().describe("The app's handle."),
        version: z
          .number()
          .int()
          .describe("Version number to make live again."),
      },
      async (args: { name: string; version: number }) => {
        try {
          const d = rollbackDeploy(args.name, args.version);
          return text(
            `Rolled ${d.name} back to v${d.currentVersion} (${d.state}).`,
          );
        } catch (e: any) {
          return text(`Rollback failed: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "stop_app",
      "Stop a published app. It stays registered with its versions intact and can be started again from Settings → Deploys, but its link returns 503 until then. Use it when an app is superseded or misbehaving — don't leave broken apps crash-looping.",
      {
        name: z.string().describe("The app's handle."),
      },
      async (args: { name: string }) => {
        const d = getDeploy(args.name);
        if (!d) return text(`No app named "${args.name}".`);
        await stopDeploy(d.id);
        return text(
          `Stopped ${d.name}. Its link now returns 503 until someone starts it again.`,
        );
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-publish", tools });
}
